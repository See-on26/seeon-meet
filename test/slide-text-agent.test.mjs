import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createSlideTextAgent, OCR_MIN_MEAN_SCORE, OCR_MAX_VERTICAL_BOX_RATIO, OCR_BYPASS_MS,
} = require('../src/main/caption-pipeline/agents/slide-text-agent.js');
const { OcrRequestError, createOcrClient } = require('../src/main/caption-pipeline/agents/shared/ocr-client.js');

const jpegBuffer = Buffer.from('x');
const vlmConfig = { vlmUrl: 'http://x', vlmModel: 'm' };
const originalFetch = globalThis.fetch;
let vlmCallCount = 0;

afterEach(() => { globalThis.fetch = originalFetch; vlmCallCount = 0; });

function mockVlm(content) {
  globalThis.fetch = async () => {
    vlmCallCount += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
}

function ocrResult({ lineList = [{ text: '3분기 매출 12.5%', height: 40, top: 80 }], meanScore = 0.95, verticalBoxRatio = 0 } = {}) {
  return { text: lineList.map((line) => line.text).join('\n'), lineList, meanScore, verticalBoxRatio };
}

function fakeOcrClient(behavior) {
  const calls = [];
  return {
    calls,
    async recognize({ jpegBuffer: buffer }) {
      calls.push(buffer);
      return behavior(calls.length);
    },
  };
}

function ocrAgent({ ocrClient }) {
  return createSlideTextAgent({ config: { ...vlmConfig, slideTextBackend: 'ocr' }, ocrClient });
}

test('기준값: 점수 0.8, 세로 글씨 0.2, 우회 60초', () => {
  assert.equal(OCR_MIN_MEAN_SCORE, 0.8);
  assert.equal(OCR_MAX_VERTICAL_BOX_RATIO, 0.2);
  assert.equal(OCR_BYPASS_MS, 60000);
});

test('vlm 백엔드(기본)는 지금처럼 VLM 으로 전사하고 출처를 남긴다', async () => {
  mockVlm('2분기 매출 | 120억 원');
  const ocrClient = fakeOcrClient(() => ocrResult());
  const agent = createSlideTextAgent({ config: vlmConfig, ocrClient });
  assert.deepEqual(await agent.transcribe({ jpegBuffer }), {
    text: '2분기 매출 | 120억 원', hasText: true, source: 'vlm', fallbackReason: null,
  });
  assert.equal(ocrClient.calls.length, 0);
});

test('ocr 백엔드: OCR 줄을 이어 글자로 쓰고 VLM 을 부르지 않는다', async () => {
  mockVlm('쓰이면 안 됨');
  const lineList = [{ text: '제목', height: 60, top: 40 }, { text: '3분기 매출 12.5%', height: 30, top: 200 }];
  const result = await ocrAgent({ ocrClient: fakeOcrClient(() => ocrResult({ lineList })) }).transcribe({ jpegBuffer });
  assert.deepEqual(result, { text: '제목\n3분기 매출 12.5%', hasText: true, source: 'ocr', fallbackReason: null, lineList });
  assert.equal(vlmCallCount, 0);
});

test('ocr 백엔드: 줄이 없거나 공백뿐이면 글자 없음, VLM 을 부르지 않는다', async () => {
  mockVlm('쓰이면 안 됨');
  for (const lineList of [[], [{ text: '   ' }, { text: '' }]]) {
    const result = await ocrAgent({ ocrClient: fakeOcrClient(() => ocrResult({ lineList, meanScore: 0 })) }).transcribe({ jpegBuffer });
    assert.deepEqual(result, { text: '', hasText: false, source: 'ocr', fallbackReason: null, lineList: [] });
  }
  assert.equal(vlmCallCount, 0);
});

test('ocr 백엔드: 점수가 낮거나 세로 글씨가 많으면 VLM 으로 넘긴다', async () => {
  mockVlm('VLM 이 읽은 글');
  const lowScore = await ocrAgent({ ocrClient: fakeOcrClient(() => ocrResult({ meanScore: 0.79 })) }).transcribe({ jpegBuffer });
  assert.deepEqual(lowScore, { text: 'VLM 이 읽은 글', hasText: true, source: 'vlm', fallbackReason: 'low_score' });
  const vertical = await ocrAgent({ ocrClient: fakeOcrClient(() => ocrResult({ verticalBoxRatio: 0.2 })) }).transcribe({ jpegBuffer });
  assert.equal(vertical.fallbackReason, 'vertical_text');
  assert.equal(vertical.source, 'vlm');
});

// 우회 창은 OCR 클라이언트가 들고 있다(수치 해설 근거와 같은 상태). 전사 쪽 동작은 그대로다.
test('ocr 백엔드: 서비스 다운이면 VLM 으로 넘기고 60초 동안 OCR 을 건너뛴다', async () => {
  const ocrUrl = 'http://127.0.0.1:8804/ocr';
  let ocrFetchCount = 0;
  globalThis.fetch = async (url) => {
    if (url === ocrUrl) { ocrFetchCount += 1; throw new Error('fetch failed'); }
    vlmCallCount += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'VLM 글' } }] }) };
  };
  let nowMs = 1000;
  const ocrClient = createOcrClient({ config: { ocrUrl }, now: () => nowMs });
  const agent = ocrAgent({ ocrClient });
  const first = await agent.transcribe({ jpegBuffer });
  assert.equal(first.source, 'vlm');
  assert.equal(first.fallbackReason, 'ocr_error:OCR 연결 실패: fetch failed');
  nowMs += OCR_BYPASS_MS - 1;
  const second = await agent.transcribe({ jpegBuffer });
  assert.equal(second.fallbackReason, 'ocr_bypass');
  assert.equal(second.source, 'vlm');
  assert.equal(ocrFetchCount, 1);
  nowMs += 1;
  await agent.transcribe({ jpegBuffer });
  assert.equal(ocrFetchCount, 2);
  assert.equal(vlmCallCount, 3);
});

test('ocr 백엔드: 4xx·형식 오류는 그 장만 VLM, 우회 창을 열지 않는다', async () => {
  mockVlm('VLM 글');
  const ocrClient = fakeOcrClient(() => { throw new OcrRequestError('OCR HTTP 400', { isServiceDown: false }); });
  const agent = ocrAgent({ ocrClient });
  assert.equal((await agent.transcribe({ jpegBuffer })).fallbackReason, 'ocr_error:OCR HTTP 400');
  await agent.transcribe({ jpegBuffer });
  assert.equal(ocrClient.calls.length, 2);
});

test('ocr 백엔드: OCR 클라이언트가 없으면 장마다 VLM', async () => {
  mockVlm('VLM 글');
  const result = await ocrAgent({ ocrClient: null }).transcribe({ jpegBuffer });
  assert.equal(result.source, 'vlm');
  assert.match(result.fallbackReason, /^ocr_error:/);
});

test('transcribeWithVlm 은 백엔드와 상관없이 VLM 으로 전사한다(값 검사 재전사용)', async () => {
  mockVlm('NONE');
  const ocrClient = fakeOcrClient(() => ocrResult());
  const result = await ocrAgent({ ocrClient }).transcribeWithVlm({ jpegBuffer });
  assert.deepEqual(result, { text: '', hasText: false, source: 'vlm', fallbackReason: null });
  assert.equal(ocrClient.calls.length, 0);
});
