import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createScreenTextGrounding, shouldStartScreenTextGrounding, finalizeScreenTextRecord, formatScreenTextSummary,
  SCREEN_TEXT_WAIT_MS, SCREEN_TEXT_CONFIDENT_SCORE,
} = require('../src/main/caption-pipeline/orchestrator/screen-text-grounding.js');
const { OcrRequestError } = require('../src/main/caption-pipeline/agents/shared/ocr-client.js');
const {
  readPipelineConfig, SCREEN_TEXT_GROUNDING_LIST, DEFAULT_SCREEN_TEXT_GROUNDING,
} = require('../src/main/caption-pipeline/config.js');

afterEach(() => { mock.restoreAll(); });

const jpegBuffer = Buffer.from('frame');
const ocrResult = ({ lineList = [{ text: '3분기 매출 182억', score: 0.95 }], meanScore = 0.95, verticalBoxRatio = 0 } = {}) => ({
  text: lineList.map((line) => line.text).join('\n'), lineList, meanScore, verticalBoxRatio, imageWidth: 1280, imageHeight: 720,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveFn, rejectFn) => { resolve = resolveFn; reject = rejectFn; });
  return { promise, resolve, reject };
}

function fakeOcrClient(behavior) {
  const callList = [];
  return {
    callList,
    recognize({ jpegBuffer: buffer }) {
      callList.push(buffer);
      return behavior(callList.length);
    },
  };
}

test('기준값: 판단 뒤 기다리는 상한 1초, 값 검사에 믿는 줄 점수 0.85', () => {
  assert.equal(SCREEN_TEXT_WAIT_MS, 1000);
  assert.equal(SCREEN_TEXT_CONFIDENT_SCORE, 0.85);
});

test('수치 트리거(단순 수치·변화)가 있을 때만 근거 OCR 을 시작한다', () => {
  assert.equal(shouldStartScreenTextGrounding({ triggerCandidateList: [{ type: 'number', phrase: '79개' }] }), true);
  assert.equal(shouldStartScreenTextGrounding({ triggerCandidateList: [{ type: 'demonstrative', phrase: '여기' }, { type: 'change', phrase: '크게 늘었습니다' }] }), true);
  assert.equal(shouldStartScreenTextGrounding({ triggerCandidateList: [{ type: 'demonstrative', phrase: '여기' }, { type: 'scale', phrase: '정말 크죠' }] }), false);
  assert.equal(shouldStartScreenTextGrounding({ triggerCandidateList: [{ type: 'number', phrase: '' }] }), false);
  assert.equal(shouldStartScreenTextGrounding({ triggerCandidateList: [] }), false);
  assert.equal(shouldStartScreenTextGrounding({}), false);
});

test('OCR 은 start 에서 바로 보낸다(판단 LLM 과 겹쳐 돌도록) · 같은 프레임 버퍼', () => {
  const ocrClient = fakeOcrClient(() => new Promise(() => {}));
  createScreenTextGrounding({ ocrClient }).start({ jpegBuffer });
  assert.equal(ocrClient.callList.length, 1);
  assert.equal(ocrClient.callList[0], jpegBuffer);
});

test('상한 안에 끝나면 빈 줄을 뺀 OCR 줄과 기록(fresh)을 돌려준다', async () => {
  const lineList = [{ text: '제목', score: 0.96 }, { text: '  ', score: 0.5 }, { text: '매출 182억', score: 0.9 }];
  const task = createScreenTextGrounding({ ocrClient: fakeOcrClient(async () => ocrResult({ lineList, meanScore: 0.93 })) }).start({ jpegBuffer });
  const { lineList: promptLineList, record } = await task.waitForPrompt();
  assert.deepEqual(promptLineList.map((line) => line.text), ['제목', '매출 182억']);
  assert.equal(record.source, 'fresh');
  assert.equal(record.skipReason, null);
  assert.equal(record.totalLineCount, 2);
  assert.equal(record.meanScore, 0.93);
  assert.ok(Number.isFinite(record.ocrMs));
  assert.ok(Number.isFinite(record.waitedMs));
});

test('상한 안에 끝나지 않으면 기다리지 않고 덩어리 없이(ocr_late) · 늦게 끝난 글자는 값 검사에 쓴다', async () => {
  const pending = deferred();
  const task = createScreenTextGrounding({ ocrClient: fakeOcrClient(() => pending.promise), waitMs: 20 }).start({ jpegBuffer });
  const startedAt = Date.now();
  const { lineList, record } = await task.waitForPrompt();
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(lineList, []);
  assert.equal(record.source, 'none');
  assert.equal(record.skipReason, 'ocr_late');
  assert.ok(elapsedMs >= 15 && elapsedMs < 500, `기다린 시간 ${elapsedMs}ms`);
  assert.ok(record.waitedMs >= 15);
  assert.equal(task.peekFrameText(), null, '끝나기 전에는 값 검사 글자가 없다');
  pending.resolve(ocrResult());
  await pending.promise;
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(task.peekFrameText(), '3분기 매출 182억');
});

test('이미 끝났으면 기다리지 않는다(대기 0에 가깝다)', async () => {
  const task = createScreenTextGrounding({ ocrClient: fakeOcrClient(async () => ocrResult()), waitMs: 5000 }).start({ jpegBuffer });
  await new Promise((resolve) => { setImmediate(resolve); });
  const startedAt = Date.now();
  const { record } = await task.waitForPrompt();
  assert.ok(Date.now() - startedAt < 100);
  assert.equal(record.source, 'fresh');
});

test('OCR 이 실패하거나 우회 중이면 덩어리 없이 이유를 남긴다', async () => {
  const cases = [
    [new OcrRequestError('OCR 서비스 응답 없음', { isServiceDown: true, isBypassed: true }), 'ocr_bypass'],
    [new OcrRequestError('OCR 연결 실패: fetch failed', { isServiceDown: true }), 'ocr_error:OCR 연결 실패: fetch failed'],
    [new OcrRequestError('OCR HTTP 400', { isServiceDown: false }), 'ocr_error:OCR HTTP 400'],
  ];
  for (const [error, skipReason] of cases) {
    const task = createScreenTextGrounding({ ocrClient: fakeOcrClient(async () => { throw error; }) }).start({ jpegBuffer });
    const { lineList, record } = await task.waitForPrompt();
    assert.deepEqual(lineList, []);
    assert.equal(record.source, 'none');
    assert.equal(record.skipReason, skipReason);
    assert.equal(task.peekFrameText(), null);
  }
});

test('글자가 없거나, 평균 점수가 0.8 아래거나, 세로 글씨가 많으면 덩어리도 값 검사 글자도 없다', async () => {
  const cases = [
    [ocrResult({ lineList: [], meanScore: 0 }), 'no_text'],
    [ocrResult({ lineList: [{ text: '   ', score: 0.9 }] }), 'no_text'],
    [ocrResult({ meanScore: 0.79 }), 'low_score'],
    [ocrResult({ verticalBoxRatio: 0.2 }), 'vertical_text'],
  ];
  for (const [result, skipReason] of cases) {
    const task = createScreenTextGrounding({ ocrClient: fakeOcrClient(async () => result) }).start({ jpegBuffer });
    const { lineList, record } = await task.waitForPrompt();
    assert.deepEqual(lineList, [], skipReason);
    assert.equal(record.source, 'none');
    assert.equal(record.skipReason, skipReason);
    assert.equal(task.peekFrameText(), null, skipReason);
  }
});

test('꺼져 있으면 OCR 을 부르지 않고 disabled', async () => {
  const ocrClient = fakeOcrClient(async () => ocrResult());
  const task = createScreenTextGrounding({ ocrClient, isEnabled: () => false }).start({ jpegBuffer });
  const { lineList, record } = await task.waitForPrompt();
  assert.equal(ocrClient.callList.length, 0);
  assert.deepEqual(lineList, []);
  assert.equal(record.source, 'none');
  assert.equal(record.skipReason, 'disabled');
  assert.equal(task.peekFrameText(), null);
});

test('OCR 클라이언트가 없으면 OCR 없이 ocr_error', async () => {
  const task = createScreenTextGrounding({ ocrClient: null }).start({ jpegBuffer });
  const { record } = await task.waitForPrompt();
  assert.equal(record.source, 'none');
  assert.match(record.skipReason, /^ocr_error:/);
});

// OCR 이 잘못 읽은 값을 해설이 따라 쓰면 같은 글자로 검사해도 통과한다. 점수가 낮은 줄은 값 검사 글자에서 빼서 VLM 재전사로 확인하게 한다.
test('값 검사 글자는 점수가 0.85 아래인 줄을 뺀다(점수가 없으면 믿는다) · 믿을 줄이 없으면 빈 문자열', async () => {
  const lineList = [
    { text: '지역별 신규 가입자', score: 0.94 }, { text: '*제험 계령 2.318건은 제의했다', score: 0.801 }, { text: '수도권 18,420명' },
  ];
  const task = createScreenTextGrounding({ ocrClient: fakeOcrClient(async () => ocrResult({ lineList, meanScore: 0.88 })) }).start({ jpegBuffer });
  const { lineList: promptLineList } = await task.waitForPrompt();
  assert.equal(promptLineList.length, 3, '프롬프트에는 점수가 낮은 줄도 넣는다');
  assert.equal(task.peekFrameText(), '지역별 신규 가입자\n수도권 18,420명');
  const lowTask = createScreenTextGrounding({
    ocrClient: fakeOcrClient(async () => ocrResult({ lineList: [{ text: '2.318건', score: 0.82 }], meanScore: 0.82 })),
  }).start({ jpegBuffer });
  await lowTask.waitForPrompt();
  assert.equal(lowTask.peekFrameText(), '');
});

test('설정: SEEON_SCREEN_TEXT_GROUNDING 은 on(기본)·off, 모르는 값은 한 번 경고하고 on', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.deepEqual(SCREEN_TEXT_GROUNDING_LIST, ['on', 'off']);
  assert.equal(DEFAULT_SCREEN_TEXT_GROUNDING, 'on');
  assert.equal(readPipelineConfig({}).isScreenTextGroundingEnabled, true);
  assert.equal(readPipelineConfig({ SEEON_SCREEN_TEXT_GROUNDING: '' }).isScreenTextGroundingEnabled, true);
  assert.equal(readPipelineConfig({ SEEON_SCREEN_TEXT_GROUNDING: 'on' }).isScreenTextGroundingEnabled, true);
  assert.equal(readPipelineConfig({ SEEON_SCREEN_TEXT_GROUNDING: 'off' }).isScreenTextGroundingEnabled, false);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(readPipelineConfig({ SEEON_SCREEN_TEXT_GROUNDING: 'OFF' }).isScreenTextGroundingEnabled, true);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /SEEON_SCREEN_TEXT_GROUNDING/);
});

test('설정: 근거 OCR 은 「화면 글자 읽기」(전사 백엔드)와 따로 켜진다', () => {
  assert.equal(readPipelineConfig({ SEEON_SLIDE_TEXT_BACKEND: 'vlm' }).isScreenTextGroundingEnabled, true);
  assert.equal(readPipelineConfig({ SEEON_SLIDE_TEXT_BACKEND: 'ocr', SEEON_SCREEN_TEXT_GROUNDING: 'off' }).slideTextBackend, 'ocr');
});

test('기록: 프롬프트에 들어간 줄 수·글자 수를 붙이고, 줄이 하나도 못 들어갔으면 none(over_char_limit)', () => {
  const record = { source: 'fresh', totalLineCount: 9, meanScore: 0.94, ocrMs: 480, waitedMs: 0, skipReason: null };
  const finalized = finalizeScreenTextRecord({ record, screenTextBlock: { lineCount: 9, charCount: 263, numberLineCount: 7 } });
  assert.deepEqual(finalized, { ...record, lineCount: 9, charCount: 263 });
  assert.equal(formatScreenTextSummary(finalized), '화면 글자=같은 프레임 OCR 9/9줄 263자 점수 0.94 OCR 480ms 대기 0ms');
  const overLimit = finalizeScreenTextRecord({ record, screenTextBlock: { lineCount: 0, charCount: 0, numberLineCount: 0 } });
  assert.equal(overLimit.source, 'none');
  assert.equal(overLimit.skipReason, 'over_char_limit');
  const late = finalizeScreenTextRecord({
    record: { source: 'none', totalLineCount: 0, meanScore: null, ocrMs: null, waitedMs: 1001, skipReason: 'ocr_late' },
  });
  assert.equal(late.lineCount, 0);
  assert.equal(formatScreenTextSummary(late), '화면 글자=없음(ocr_late, 대기 1001ms)');
  assert.equal(formatScreenTextSummary({ source: 'none', waitedMs: 0, skipReason: 'disabled' }), '화면 글자=없음(disabled)');
});
