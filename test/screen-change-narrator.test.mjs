import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createScreenChangeNarrator, SCREEN_CHANGE_DECISION_MAP, SCREEN_CHANGE_ORIGIN_MAP,
} = require('../src/main/caption-pipeline/orchestrator/screen-change-narrator.js');
const { createScreenChangeGate } = require('../src/main/caption-pipeline/orchestrator/screen-change-gate.js');
const { createPendingEvidence } = require('../src/main/caption-pipeline/orchestrator/pending-evidence.js');
const { createScreenChangeBaseline } = require('../src/main/caption-pipeline/orchestrator/screen-change-baseline.js');

const IMAGE = { imageWidth: 1000, imageHeight: 1000 };

function ocrLine(text, top, { left = 100, width = 400, height = 40, score = 0.97 } = {}) {
  return { text, left, top, width, height, score };
}

function ocrResponse(lineList) {
  return {
    text: lineList.map((line) => line.text).join('\n'), lineList, meanScore: 0.97, verticalBoxRatio: 0, ...IMAGE,
  };
}

const BASE_LINE_LIST = [ocrLine('분기 실적', 50), ocrLine('영업이익 추이', 150)];
const CHANGED_LINE_LIST = [...BASE_LINE_LIST, ocrLine('3분기 매출 42억 원', 600)];
const REGION = { x: 0.08, y: 0.58, w: 0.45, h: 0.08 };

function createHarness({ mode = 'same_slide', ocrList = [], vlmContent = null, isRateLimited = false, now = () => 10000,
  retryResult = { isVlmCalled: true, isEmitted: true, skipReason: null } } = {}) {
  const callMap = { ocr: 0, describe: 0, retry: [], emit: [], record: [] };
  const queue = [...ocrList];
  const pendingEvidence = createPendingEvidence({ now });
  const baselineStore = createScreenChangeBaseline();
  const narrator = createScreenChangeNarrator({
    getMode: () => mode,
    gate: createScreenChangeGate(),
    pendingEvidence,
    baselineStore,
    recognize: async () => { callMap.ocr += 1; return queue.shift(); },
    findRateLimited: () => ({ isRateLimited, sinceMs: 5000, minIntervalMs: 20000 }),
    getRecentNarrationTextList: () => [],
    describe: async (args) => { callMap.describe += 1; callMap.describeArgs = args; return vlmContent; },
    retry: async (args) => { callMap.retry.push(args); return retryResult; },
    emit: async (args) => { callMap.emit.push(args); return { isEmitted: true, reason: null }; },
    record: async (rec) => { callMap.record.push(rec); },
    now,
  });
  return { narrator, callMap, pendingEvidence, baselineStore };
}

async function seedBaseline({ narrator }) {
  await narrator.handleBaseline({ slideLabel: '2', buffer: Buffer.from('base'), ts: 1000, isSlideStart: true, slideStartTs: 0 });
}

function changePayload(extra = {}) {
  return {
    ts: 9000, slideLabel: '2', buffer: Buffer.from('clean'), vlmBuffer: Buffer.from('outline'), regionNorm: REGION,
    changedRatio: 0.02, cellCount: 12, firstSeenTs: 8000, firstSeenVideoTimeMs: 61000, recentTranscript: '자 결과를 보시면',
    wordBudget: { minWordCount: 3, maxWordCount: 8 }, ...extra,
  };
}

const grounded = (target, value) => ({
  text: `새로 표시, ${target} ${value}`, isGrounded: true, slotMap: { target, value },
});

test('새 숫자 줄과 VLM 답이 있으면 화면 변화 분류로 내보내고 사건 시각은 처음 본 시각이다(VLM 1회)', async () => {
  const harness = createHarness({
    ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)],
    vlmContent: grounded('3분기 매출', '42억 원'),
  });
  await seedBaseline(harness);
  const record = await harness.narrator.handleChange(changePayload());
  assert.equal(harness.callMap.describe, 1);
  assert.equal(harness.callMap.describeArgs.jpegBuffer.toString(), 'outline');
  assert.deepEqual(harness.callMap.describeArgs.lineList, ['3분기 매출 42억 원']);
  assert.equal(harness.callMap.emit.length, 1);
  const [emitted] = harness.callMap.emit;
  assert.equal(emitted.text, '새로 표시, 3분기 매출 42억 원');
  assert.equal(emitted.eventVideoTimeMs, 61000);
  assert.equal(emitted.eventKind, 'new_text');
  assert.equal(record.decision, SCREEN_CHANGE_DECISION_MAP.emitted);
  assert.equal(record.kind, 'screen_change');
  assert.equal(record.origin, SCREEN_CHANGE_ORIGIN_MAP.sameSlide);
  assert.equal(record.isVlmCalled, true);
  assert.equal(record.ocr.addedLineCount, 1);
  assert.deepEqual(harness.callMap.record.at(-1), record);
});

test('새 줄이 모두 받아쓰기에 있으면 VLM 을 부르지 않는다(spoken)', async () => {
  const harness = createHarness({ ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)] });
  await seedBaseline(harness);
  const record = await harness.narrator.handleChange(changePayload({ recentTranscript: '3분기 매출은 42억 원을 넘었습니다' }));
  assert.equal(harness.callMap.describe, 0);
  assert.equal(record.skipReason, 'spoken');
  assert.equal(record.spokenFilteredCount, 1);
});

test('VLM 이 NONE 이면 내보내지 않는다(vlm_none)', async () => {
  const harness = createHarness({
    ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)],
    vlmContent: { text: '', isGrounded: false, slotMap: null, rejectKind: 'none', rejectReason: '재생 조작 버튼' },
  });
  await seedBaseline(harness);
  const record = await harness.narrator.handleChange(changePayload());
  assert.equal(harness.callMap.emit.length, 0);
  assert.equal(record.skipReason, 'vlm_none');
  assert.equal(record.rejectKind, 'none');
});

test('VLM 값이 새 줄에 없으면 버린다(value_absent)', async () => {
  const harness = createHarness({
    ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)],
    vlmContent: grounded('3분기 매출', '45억 원'),
  });
  await seedBaseline(harness);
  const record = await harness.narrator.handleChange(changePayload());
  assert.equal(harness.callMap.emit.length, 0);
  assert.equal(record.skipReason, 'value_absent');
});

test('미해결 수치 트리거가 있으면 원래 에이전트를 새 화면으로 다시 부르고 변화 에이전트는 부르지 않는다', async () => {
  const harness = createHarness({ ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)] });
  await seedBaseline(harness);
  const isNoted = await harness.narrator.noteUnresolved({
    ts: 7000, captureTs: 6900, slideLabel: '2', narrationType: 'interpretation', subKind: 'claim_to_value', rejectKind: 'none',
  });
  assert.equal(isNoted, true);
  const record = await harness.narrator.handleChange(changePayload());
  assert.equal(harness.callMap.describe, 0);
  assert.equal(harness.callMap.retry.length, 1);
  const [retryArgs] = harness.callMap.retry;
  assert.equal(retryArgs.note.narrationType, 'interpretation');
  assert.equal(retryArgs.frame.buffer.toString(), 'clean');
  assert.deepEqual(retryArgs.frame.lineList.map((line) => line.text), CHANGED_LINE_LIST.map((line) => line.text));
  assert.equal(retryArgs.eventVideoTimeMs, 61000);
  assert.equal(record.origin, SCREEN_CHANGE_ORIGIN_MAP.retry);
  assert.equal(record.retryOfTs, 7000);
  assert.equal(record.decision, SCREEN_CHANGE_DECISION_MAP.emitted);
});

test('간격 안이면 OCR·VLM 을 부르지 않는다(gate:interval)', async () => {
  const harness = createHarness({ isRateLimited: true, ocrList: [ocrResponse(BASE_LINE_LIST)] });
  await seedBaseline(harness);
  const ocrBefore = harness.callMap.ocr;
  const record = await harness.narrator.handleChange(changePayload());
  assert.equal(harness.callMap.ocr, ocrBefore);
  assert.equal(harness.callMap.describe, 0);
  assert.equal(record.skipReason, 'gate:interval');
});

test('shadow 면 OCR 은 하고 VLM 은 부르지 않으며 기록만 남긴다', async () => {
  const harness = createHarness({ mode: 'shadow', ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)] });
  await seedBaseline(harness);
  assert.equal(harness.callMap.ocr, 1);
  const record = await harness.narrator.handleChange(changePayload());
  assert.equal(harness.callMap.ocr, 2);
  assert.equal(harness.callMap.describe, 0);
  assert.equal(harness.callMap.emit.length, 0);
  assert.equal(record.decision, SCREEN_CHANGE_DECISION_MAP.shadow);
  assert.equal(record.isVlmCalled, false);
  assert.equal(record.eventKind, 'new_text');
});

test('off 면 아무것도 부르지 않는다', async () => {
  const harness = createHarness({ mode: 'off', ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)] });
  await seedBaseline(harness);
  await harness.narrator.handleChange(changePayload());
  const isNoted = await harness.narrator.noteUnresolved({ ts: 1, captureTs: 0, slideLabel: '2', rejectKind: 'none' });
  assert.equal(isNoted, false);
  assert.equal(harness.callMap.ocr, 0);
  assert.equal(harness.callMap.describe, 0);
  assert.equal(harness.callMap.emit.length, 0);
  assert.equal(harness.callMap.record.length, 0);
});

test('기준 화면이 없으면 VLM 을 부르지 않는다(baseline_missing), 그 사건 화면이 다음 기준이 된다', async () => {
  const harness = createHarness({
    ocrList: [ocrResponse(CHANGED_LINE_LIST), ocrResponse([...CHANGED_LINE_LIST, ocrLine('신규 고객 1,250명', 650)])],
    vlmContent: grounded('신규 고객', '1,250명'),
  });
  const first = await harness.narrator.handleChange(changePayload());
  assert.equal(first.skipReason, 'baseline_missing');
  assert.equal(harness.callMap.describe, 0);
  const second = await harness.narrator.handleChange(changePayload({ ts: 30000, firstSeenTs: 29000 }));
  assert.equal(second.decision, SCREEN_CHANGE_DECISION_MAP.emitted);
  assert.deepEqual(harness.callMap.describeArgs.lineList, ['신규 고객 1,250명']);
});

test('OCR 이 실패하면 ocr_error 로 끝내고 게이트를 반납한다', async () => {
  const harness = createHarness({ ocrList: [ocrResponse(BASE_LINE_LIST)] });
  await seedBaseline(harness);
  const narrator = harness.narrator;
  const record = await narrator.handleChange(changePayload());
  assert.match(record.skipReason, /^ocr_error/);
  const again = await narrator.handleChange(changePayload());
  assert.notEqual(again.skipReason, 'gate:in_flight');
});

test('늦게 온 미해결 결과는 캡처 뒤에 생긴 처리 대기 변화(in_flight 로 밀린 것)와 짝지어 다시 부른다', async () => {
  let release = null;
  const blocker = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({ ocrList: [ocrResponse(BASE_LINE_LIST)] });
  await seedBaseline(harness);
  const callMap = harness.callMap;
  const narrator = createScreenChangeNarrator({
    getMode: () => 'same_slide', gate: createScreenChangeGate(), pendingEvidence: harness.pendingEvidence,
    baselineStore: harness.baselineStore,
    recognize: async () => { callMap.ocr += 1; await blocker; return ocrResponse(CHANGED_LINE_LIST); },
    findRateLimited: () => ({ isRateLimited: false }), getRecentNarrationTextList: () => [],
    describe: async () => { callMap.describe += 1; return grounded('3분기 매출', '42억 원'); },
    retry: async (args) => { callMap.retry.push(args); return { isVlmCalled: true, isEmitted: true, skipReason: null }; },
    emit: async () => ({ isEmitted: true }), record: async (rec) => { callMap.record.push(rec); }, now: () => 10000,
  });
  const firstPromise = narrator.handleChange(changePayload());
  const gated = await narrator.handleChange(changePayload({ ts: 9500, firstSeenTs: 8800, buffer: Buffer.from('second') }));
  assert.equal(gated.skipReason, 'gate:in_flight');
  release();
  await firstPromise;
  const isNoted = await narrator.noteUnresolved({
    ts: 8000, captureTs: 8500, slideLabel: '2', narrationType: 'deixis', rejectKind: 'none',
  });
  assert.equal(isNoted, false, '짝지은 변화로 바로 다시 불렀으므로 적어 두지 않는다');
  assert.equal(callMap.retry.length, 1);
  assert.equal(callMap.retry[0].frame.buffer.toString(), 'second');
  assert.equal(callMap.record.at(-1).origin, SCREEN_CHANGE_ORIGIN_MAP.retry);
});

test('다음 슬라이드 기준 화면이 트리거 뒤 10초 안에 오면 원래 에이전트를 그 화면으로 다시 부른다', async () => {
  const harness = createHarness({ ocrList: [ocrResponse(BASE_LINE_LIST)] });
  await harness.narrator.noteUnresolved({
    ts: 5000, captureTs: 4900, slideLabel: '1', narrationType: 'interpretation', rejectKind: 'none',
  });
  await harness.narrator.handleBaseline({
    slideLabel: '2', buffer: Buffer.from('next'), ts: 9000, isSlideStart: true, slideStartTs: 5500, eventVideoTimeMs: 70000,
  });
  assert.equal(harness.callMap.retry.length, 1);
  assert.equal(harness.callMap.retry[0].frame.buffer.toString(), 'next');
  assert.equal(harness.callMap.retry[0].slideLabel, '2');
  const record = harness.callMap.record.at(-1);
  assert.equal(record.origin, SCREEN_CHANGE_ORIGIN_MAP.retry);
  assert.equal(record.eventKind, 'new_slide');
});

test('렌더러가 버린 화면 변화 해설은 그 슬라이드 횟수를 되돌린다', async () => {
  const harness = createHarness();
  assert.equal(harness.narrator.revert({ slideLabel: '2' }), false);
});

test('shadow 에서 늦게 온 미해결 결과가 보관한 변화와 짝지어지면 기록만 하고 다시 적지 않는다', async () => {
  const harness = createHarness({ mode: 'shadow', ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)] });
  await seedBaseline(harness);
  await harness.narrator.handleChange(changePayload());
  const isNoted = await harness.narrator.noteUnresolved({
    ts: 7500, captureTs: 7000, slideLabel: '2', narrationType: 'deixis', rejectKind: 'none',
  });
  assert.equal(isNoted, false);
  const record = harness.callMap.record.at(-1);
  assert.equal(record.decision, 'shadow');
  assert.equal(record.origin, 'retry');
  assert.equal(record.wouldRetry, true);
  assert.equal(harness.pendingEvidence.peekForChange({ slideLabel: '2', changeTs: 9900 }), null);
});
