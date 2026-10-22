import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createScreenChangeService } = require('../src/main/caption-pipeline/orchestrator/screen-change-service.js');
const { createNarrationHistory } = require('../src/main/caption-pipeline/orchestrator/narration-history.js');
const { createDescribedStore } = require('../src/main/caption-pipeline/orchestrator/described-store.js');
const { createCaptionDescribedRegistry } = require('../src/main/caption-pipeline/orchestrator/caption-described-registry.js');
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');

const IMAGE = { imageWidth: 1000, imageHeight: 1000 };
const ocrLine = (text, top) => ({ text, left: 100, top, width: 400, height: 40, score: 0.97 });
const ocrResponse = (lineList) => ({ text: '', lineList, meanScore: 0.97, verticalBoxRatio: 0, ...IMAGE });

function createHarness({ env = { SEEON_SCREEN_CHANGE: 'same_slide' }, ocrList = [], agentResultMap = {} } = {}) {
  const callMap = { agent: [], sendCaption: [], record: [], debug: [] };
  const queue = [...ocrList];
  const describedStore = createDescribedStore();
  const agentFieldMap = Object.fromEntries(['deixis', 'interpretation', 'visual_description', 'screen_change'].map((type) => [type, {
    generate: async (args) => { callMap.agent.push({ type, args }); return agentResultMap[type]; },
  }]));
  const service = createScreenChangeService({
    config: readPipelineConfig(env),
    agentFieldMap,
    ocrClient: { recognize: async () => queue.shift() },
    narrationHistory: createNarrationHistory(),
    describedStore,
    captionDescribed: createCaptionDescribedRegistry({ describedStore }),
    slideTextStore: { get: () => ({ text: '', status: 'pending' }) },
    sendCaption: async (args) => { callMap.sendCaption.push(args); return { isEmitted: true }; },
    appendRecord: async (rec) => { callMap.record.push(rec); },
    markDebug: (entry) => { callMap.debug.push(entry); },
    now: () => 10000,
  });
  return { service, callMap };
}

const BASE_LINE_LIST = [ocrLine('분기 실적', 50)];
const CHANGED_LINE_LIST = [...BASE_LINE_LIST, ocrLine('3분기 매출 42억 원', 600)];

function deixisContext(extra = {}) {
  return {
    ts: 7000, frameTs: 6800, slideLabel: '2', narrationType: 'interpretation',
    selectedCandidate: { type: 'interpretation', subKind: 'claim_to_value', anchor: '크게 늘었' },
    generatorArgs: {
      jpegBuffer: Buffer.from('old'), utterance: '매출이 크게 늘었습니다', recentTranscript: '', describedElementList: ['옛 것'],
      minWordCount: 6, maxWordCount: 12, subKind: 'claim_to_value', mergedAnchorList: [], mergedClaimList: [],
    },
    rejectKind: 'none', beforeText: '', afterText: '',
    ...extra,
  };
}

// 발화 ROI 의 확대 그림은 원래 판정 프레임의 일부다. 새 화면으로 다시 볼 때 옛 확대를 둘째 장으로 붙이면 두 장이 다른 순간이 된다.
test('늦은 근거 재시도: 원래 요청의 확대 그림(발화 ROI)은 넘기지 않고 새 화면 한 장으로 다시 본다', async () => {
  const { service, callMap } = createHarness({
    ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)],
    agentResultMap: {
      interpretation: { text: '3분기 매출, 42억 원', isGrounded: true, slotMap: { target: '3분기 매출', value: '42억 원' } },
    },
  });
  await service.handleBaseline({ slideLabel: '2', buffer: [1], ts: 1000, isSlideStart: true, slideStartTs: 0 });
  const context = deixisContext();
  await service.noteUnresolved({
    ...context,
    generatorArgs: { ...context.generatorArgs, zoomJpegBuffer: Buffer.from('old-zoom'), zoomKind: 'speech', zoomTerm: '매출' },
  });
  await service.handleChange({
    ts: 9000, slideLabel: '2', buffer: [2], vlmBuffer: [3], regionNorm: { x: 0.08, y: 0.58, w: 0.45, h: 0.08 },
    changedRatio: 0.02, cellCount: 10, firstSeenTs: 8000, firstSeenVideoTimeMs: 61000, recentTranscript: '',
  });
  assert.deepEqual(callMap.agent.map((call) => call.type), ['interpretation']);
  const { args } = callMap.agent[0];
  assert.equal(Buffer.from(args.jpegBuffer).toString('hex'), Buffer.from([2]).toString('hex'));
  for (const key of ['zoomJpegBuffer', 'zoomKind', 'zoomTerm']) assert.ok(!(key in args), key);
  assert.equal(args.utterance, '매출이 크게 늘었습니다');
});

test('미해결 수치 트리거 뒤 같은 슬라이드 변화가 오면 수치 에이전트를 새 화면·새 OCR 줄로 한 번 부르고 발화 기반으로 낸다', async () => {
  const { service, callMap } = createHarness({
    ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)],
    agentResultMap: {
      interpretation: { text: '3분기 매출, 42억 원', isGrounded: true, slotMap: { target: '3분기 매출', value: '42억 원' } },
    },
  });
  await service.handleBaseline({ slideLabel: '2', buffer: [1], ts: 1000, isSlideStart: true, slideStartTs: 0 });
  await service.noteUnresolved(deixisContext());
  await service.handleChange({
    ts: 9000, slideLabel: '2', buffer: [2], vlmBuffer: [3], regionNorm: { x: 0.08, y: 0.58, w: 0.45, h: 0.08 },
    changedRatio: 0.02, cellCount: 10, firstSeenTs: 8000, firstSeenVideoTimeMs: 61000, recentTranscript: '',
  });
  assert.deepEqual(callMap.agent.map((call) => call.type), ['interpretation']);
  const { args } = callMap.agent[0];
  assert.equal(Buffer.from(args.jpegBuffer).toString('hex'), Buffer.from([2]).toString('hex'));
  assert.deepEqual(args.screenLineList.map((line) => line.text), ['분기 실적', '3분기 매출 42억 원']);
  assert.equal(args.utterance, '매출이 크게 늘었습니다');
  assert.ok(!args.describedElementList.includes('옛 것'), '이미 안내한 것은 지금 기준으로 다시 모은다');
  assert.equal(callMap.sendCaption.length, 1);
  assert.equal(callMap.sendCaption[0].narrationClass, 'speech_based');
  assert.equal(callMap.sendCaption[0].eventVideoTimeMs, 61000);
  const deixisRecord = callMap.record.find((rec) => rec.kind === 'deixis');
  assert.equal(deixisRecord.origin, 'screen_change_retry');
  assert.equal(deixisRecord.retryOfTs, 7000);
  const changeRecord = callMap.record.find((rec) => rec.kind === 'screen_change');
  assert.equal(changeRecord.origin, 'retry');
  assert.equal(changeRecord.decision, 'emitted');
});

test('다시 부른 수치 해설의 값이 새 화면 글자에 없으면 내지 않는다(VLM 재전사 없이)', async () => {
  const { service, callMap } = createHarness({
    ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)],
    agentResultMap: {
      interpretation: { text: '3분기 매출, 45억 원', isGrounded: true, slotMap: { target: '3분기 매출', value: '45억 원' } },
    },
  });
  await service.handleBaseline({ slideLabel: '2', buffer: [1], ts: 1000, isSlideStart: true, slideStartTs: 0 });
  await service.noteUnresolved(deixisContext());
  await service.handleChange({
    ts: 9000, slideLabel: '2', buffer: [2], regionNorm: { x: 0.08, y: 0.58, w: 0.45, h: 0.08 }, firstSeenTs: 8000,
  });
  assert.equal(callMap.agent.length, 1);
  assert.equal(callMap.sendCaption.length, 0);
  const changeRecord = callMap.record.find((rec) => rec.kind === 'screen_change');
  assert.equal(changeRecord.skipReason, 'value_absent');
});

test('지시 해설은 가리킨 영역 없이 전체 화면으로 다시 부른다', async () => {
  const { service, callMap } = createHarness({
    ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)],
    agentResultMap: { deixis: { text: '3분기 매출 표', isGrounded: true, slotMap: { caption: '3분기 매출 표' } } },
  });
  await service.handleBaseline({ slideLabel: '2', buffer: [1], ts: 1000, isSlideStart: true, slideStartTs: 0 });
  await service.noteUnresolved(deixisContext({ narrationType: 'deixis', selectedCandidate: { type: 'deixis', subKind: 'simple' } }));
  await service.handleChange({
    ts: 9000, slideLabel: '2', buffer: [2], regionNorm: { x: 0.08, y: 0.58, w: 0.45, h: 0.08 }, firstSeenTs: 8000,
  });
  assert.equal(callMap.agent[0].type, 'deixis');
  assert.equal(callMap.agent[0].args.hasPointingRegion, false);
  assert.equal(callMap.sendCaption[0].narrationClass, 'deixis');
});

test('같은 슬라이드 변화 해설은 화면 변화 분류·화면 변화 source 로 내보내고 이미 설명한 요소에 넣는다', async () => {
  const { service, callMap } = createHarness({
    ocrList: [ocrResponse(BASE_LINE_LIST), ocrResponse(CHANGED_LINE_LIST)],
    agentResultMap: {
      screen_change: { text: '새로 표시, 3분기 매출 42억 원', isGrounded: true, slotMap: { target: '3분기 매출', value: '42억 원' } },
    },
  });
  await service.handleBaseline({ slideLabel: '2', buffer: [1], ts: 1000, isSlideStart: true, slideStartTs: 0 });
  await service.handleChange({
    ts: 9000, slideLabel: '2', buffer: [2], vlmBuffer: [3], regionNorm: { x: 0.08, y: 0.58, w: 0.45, h: 0.08 },
    firstSeenTs: 8000, firstSeenVideoTimeMs: 61000, wordBudget: { minWordCount: 3, maxWordCount: 8 },
  });
  assert.equal(callMap.agent[0].type, 'screen_change');
  assert.equal(callMap.agent[0].args.imageMode, 'outline');
  assert.equal(callMap.agent[0].args.maxWordCount, 8);
  const [sent] = callMap.sendCaption;
  assert.equal(sent.narrationClass, 'screen_change');
  assert.equal(sent.source, 'screen_change');
  assert.equal(sent.rationale.subKind, 'new_text');
  assert.ok(callMap.debug.some((entry) => entry.stage === 'screen_change' && entry.verdict === 'pass'));
});

test('세션 설명은 모드·그림·종류·상한을 담는다', () => {
  const { service } = createHarness({ env: { SEEON_SCREEN_CHANGE: 'shadow' } });
  assert.deepEqual(service.describeSession(), {
    mode: 'shadow', image: 'outline', kindList: ['new_text', 'highlight'], minIntervalMs: 20000, perSlideMax: 2,
  });
});

test('꺼져 있으면 미해결 결과도 적지 않는다', async () => {
  const { service, callMap } = createHarness({ env: {} });
  assert.equal(await service.noteUnresolved(deixisContext()), false);
  assert.equal(callMap.record.length, 0);
});

test('세션 시작 기록 문구는 꺼져 있으면 off, 켜져 있으면 설정을 함께 적는다', () => {
  assert.equal(createHarness({ env: {} }).service.describeSessionText(), 'off');
  assert.equal(
    createHarness().service.describeSessionText(),
    'same_slide(간격 20초 · 슬라이드당 2번 · 종류 new_text,highlight · 그림 outline)',
  );
});
