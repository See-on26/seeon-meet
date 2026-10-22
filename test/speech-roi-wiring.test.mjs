import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import { toPointingRect } from '../src/renderer/core/capture/deixis-frame-set.js';

const require = createRequire(import.meta.url);
const {
  readPipelineConfig, SPEECH_ROI_MODE_LIST, DEFAULT_SPEECH_ROI_MODE, SPEECH_ROI_TYPE_LIST,
} = require('../src/main/caption-pipeline/config.js');
const {
  createSpeechRoiResolver, buildZoomAgentArgs, formatSpeechRoiSummary, SPEECH_ROI_STATUS_MAP,
} = require('../src/main/caption-pipeline/orchestrator/speech-roi/index.js');
const { SLIDE_LAYOUT_STATUS_MAP } = require('../src/main/caption-pipeline/orchestrator/speech-roi/slide-layout-store.js');
const { THUMB_WIDTH, THUMB_HEIGHT } = require('../src/main/caption-pipeline/orchestrator/speech-roi/frame-image.js');
const { ZOOM_KIND_MAP } = require('../src/main/caption-pipeline/prompts/zoom-image-intro.js');
const { createScreenTextGrounding } = require('../src/main/caption-pipeline/orchestrator/screen-text-grounding.js');
const { createDeixisResolutionAgent } = require('../src/main/caption-pipeline/agents/deixis-resolution-agent.js');
const { createInterpretiveBridgeAgent } = require('../src/main/caption-pipeline/agents/interpretive-bridge-agent.js');
const { createVisualDescriptionAgent } = require('../src/main/caption-pipeline/agents/visual-description-agent.js');
const { buildGroundingPrompt } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');
const { buildVisualDescriptionPrompt } = require('../src/main/caption-pipeline/prompts/visual-description.js');

const originalFetch = globalThis.fetch;
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
});

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

// ── 설정 ──

test('설정: 발화 ROI 는 제품 기본 꺼짐, 유형은 지시·수치·척도, 지시 OCR 꺼짐, 가리킴 짝 켬', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.deepEqual(SPEECH_ROI_MODE_LIST, ['on', 'off']);
  assert.equal(DEFAULT_SPEECH_ROI_MODE, 'off');
  assert.deepEqual(SPEECH_ROI_TYPE_LIST, ['deixis', 'interpretation', 'visual_description']);
  const config = readPipelineConfig({});
  assert.equal(config.speechRoiMode, 'off');
  assert.deepEqual(config.speechRoiTypeList, SPEECH_ROI_TYPE_LIST);
  assert.equal(config.isSpeechRoiFrameOcrEnabled, false);
  assert.equal(config.isSpeechRoiPointingPairEnabled, true);
  const emptyConfig = readPipelineConfig({ SEEON_SPEECH_ROI: '', SEEON_SPEECH_ROI_TYPES: '', SEEON_SPEECH_ROI_FRAME_OCR: '', SEEON_SPEECH_ROI_POINTING_PAIR: '' });
  assert.equal(emptyConfig.speechRoiMode, 'off');
  assert.deepEqual(emptyConfig.speechRoiTypeList, SPEECH_ROI_TYPE_LIST);
  assert.equal(warn.mock.callCount(), 0);
});

test('설정: 올바른 값은 그대로 읽는다', () => {
  const warn = mock.method(console, 'warn', () => {});
  const config = readPipelineConfig({
    SEEON_SPEECH_ROI: 'on', SEEON_SPEECH_ROI_TYPES: 'deixis, interpretation', SEEON_SPEECH_ROI_FRAME_OCR: 'on', SEEON_SPEECH_ROI_POINTING_PAIR: 'off',
  });
  assert.equal(config.speechRoiMode, 'on');
  assert.deepEqual(config.speechRoiTypeList, ['deixis', 'interpretation']);
  assert.equal(config.isSpeechRoiFrameOcrEnabled, true);
  assert.equal(config.isSpeechRoiPointingPairEnabled, false);
  assert.equal(warn.mock.callCount(), 0);
});

test('설정: 모르는 값은 값마다 경고하고 기본값으로 둔다(유형 목록은 모르는 유형만 뺀다)', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(readPipelineConfig({ SEEON_SPEECH_ROI: 'ON' }).speechRoiMode, 'off');
  assert.deepEqual(readPipelineConfig({ SEEON_SPEECH_ROI_TYPES: 'deixis,scale' }).speechRoiTypeList, ['deixis']);
  assert.deepEqual(readPipelineConfig({ SEEON_SPEECH_ROI_TYPES: 'scale' }).speechRoiTypeList, SPEECH_ROI_TYPE_LIST);
  assert.equal(readPipelineConfig({ SEEON_SPEECH_ROI_FRAME_OCR: 'yes' }).isSpeechRoiFrameOcrEnabled, false);
  assert.equal(readPipelineConfig({ SEEON_SPEECH_ROI_POINTING_PAIR: '0' }).isSpeechRoiPointingPairEnabled, true);
  assert.equal(warn.mock.callCount(), 5);
  for (const call of warn.mock.calls) assert.match(call.arguments[0], /SEEON_SPEECH_ROI/);
});

// ── 리졸버 ──

const onConfig = (extra = {}) => ({
  speechRoiMode: 'on', speechRoiTypeList: ['deixis', 'interpretation', 'visual_description'],
  isSpeechRoiFrameOcrEnabled: false, isSpeechRoiPointingPairEnabled: true, ...extra,
});
const grayThumb = (value = 100) => ({ width: THUMB_WIDTH, height: THUMB_HEIGHT, data: new Uint8Array(THUMB_WIDTH * THUMB_HEIGHT).fill(value) });
function fakeImageOps({ thumb = grayThumb(), size = { width: 1280, height: 720 }, cropResult } = {}) {
  const cropList = [];
  return {
    cropList,
    readSize: () => size,
    toGrayThumbnail: () => thumb,
    cropToJpeg: ({ jpeg, rect }) => {
      cropList.push({ jpeg, rect });
      return cropResult === undefined ? Buffer.from(`zoom:${rect.x.toFixed(2)},${rect.y.toFixed(2)}`) : cropResult;
    },
  };
}
const layoutStoreOf = (entry = { status: SLIDE_LAYOUT_STATUS_MAP.missing, layout: null }) => ({ get: () => entry });
const ocrLine = (text, { left = 128, top = 360, width = 256, height = 30, score = 0.95 } = {}) => ({ text, score, left, top, width, height });
const frameLayoutOf = (lineList) => ({ lineList, imageWidth: 1280, imageHeight: 720 });
const SALES_LINE_LIST = [
  ocrLine('서울 지역 182억', { left: 128, top: 360 }),
  ocrLine('부산 지역 95억 RSU 79개', { left: 900, top: 100, width: 300 }),
];
const screenFrame = Buffer.from('screen');
const regionFrame = Buffer.from('region');
const baseArgs = {
  narrationType: 'deixis', subKind: 'simple', utterance: '여기 서울 지역 보시면', before: '', after: '', anchor: '여기',
  slideLabel: '1', screenFrame, frameLayout: frameLayoutOf(SALES_LINE_LIST), pointingRect: null, regionFrame: null,
};

test('꺼짐: 리졸버는 아무것도 하지 않고 확대·기록이 없다(낱말·위치·그림을 건드리지 않는다)', () => {
  const explode = () => { throw new Error('불리면 안 된다'); };
  const resolver = createSpeechRoiResolver({
    config: onConfig({ speechRoiMode: 'off' }),
    tokenizer: { tokenize: explode }, layoutStore: { get: explode }, imageOps: { readSize: explode, toGrayThumbnail: explode, cropToJpeg: explode },
  });
  assert.equal(resolver.isEnabled(), false);
  assert.equal(resolver.shouldStartFrameOcr(), false);
  const result = resolver.resolve({ ...baseArgs, pointingRect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, regionFrame });
  assert.deepEqual(result, { zoomJpegBuffer: null, zoomKind: null, zoomTerm: null, record: null });
  assert.deepEqual(buildZoomAgentArgs({ roiResult: result, screenFrame }), {});
});

test('켬 + 맞음: 같은 프레임 OCR 줄 위치로 확대를 만들고 기록을 남긴다', () => {
  const imageOps = fakeImageOps();
  const resolver = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(), imageOps, now: (() => { let t = 0; return () => (t += 2); })() });
  const result = resolver.resolve(baseArgs);
  assert.ok(Buffer.isBuffer(result.zoomJpegBuffer));
  assert.equal(result.zoomKind, ZOOM_KIND_MAP.speech);
  assert.equal(result.zoomTerm, '서울');
  assert.equal(imageOps.cropList.length, 1);
  assert.equal(imageOps.cropList[0].jpeg, screenFrame, '확대는 전체 화면 JPEG 에서 자른다');
  const { record } = result;
  assert.equal(record.mode, 'on');
  assert.equal(record.status, SPEECH_ROI_STATUS_MAP.used);
  assert.equal(record.layoutSource, 'frame_ocr');
  assert.equal(record.term, '서울');
  assert.equal(record.termSource, 'utterance');
  assert.equal(record.matchKind, 'exact');
  assert.ok(record.score > 1);
  assert.equal(record.lineText, '서울 지역 182억');
  assert.equal(record.spanEstimated, false);
  assert.deepEqual(Object.keys(record.rect).sort(), ['h', 'w', 'x', 'y']);
  assert.equal(record.zoomKind, ZOOM_KIND_MAP.speech);
  assert.equal(record.pointingConflict, false);
  assert.equal(record.freshness, null, '같은 프레임 OCR 은 신선도 확인을 하지 않는다');
  assert.equal(record.elapsedMs, 2);
  assert.match(formatSpeechRoiSummary(record), /발화 ROI=used .*같은 프레임 OCR.*"서울".*exact/);
  assert.deepEqual(buildZoomAgentArgs({ roiResult: result, screenFrame }), {
    jpegBuffer: screenFrame, zoomJpegBuffer: result.zoomJpegBuffer, zoomKind: ZOOM_KIND_MAP.speech, zoomTerm: '서울',
  });
});

test('켬: 같은 프레임 OCR 이 없으면 전환 때 뽑은 위치를 신선도 확인 뒤 쓰고, 낡았으면 확대하지 않는다', () => {
  const layout = {
    aspect: 1280 / 720, thumb: grayThumb(),
    lineList: [{ text: '서울 지역 182억', score: 0.95, rect: { x: 0.1, y: 0.5, w: 0.2, h: 0.04 } }],
  };
  const ready = { status: SLIDE_LAYOUT_STATUS_MAP.ready, layout };
  const fresh = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(ready), imageOps: fakeImageOps() })
    .resolve({ ...baseArgs, frameLayout: null });
  assert.equal(fresh.record.status, SPEECH_ROI_STATUS_MAP.used);
  assert.equal(fresh.record.layoutSource, 'slide_ocr');
  assert.equal(fresh.record.freshness.isFresh, true);
  const stale = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(ready), imageOps: fakeImageOps({ thumb: grayThumb(160) }) })
    .resolve({ ...baseArgs, frameLayout: null });
  assert.equal(stale.zoomJpegBuffer, null);
  assert.equal(stale.record.status, 'stale:slide_changed');
  assert.equal(stale.record.freshness.reason, 'slide_changed');
  const resized = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(ready), imageOps: fakeImageOps({ size: { width: 1280, height: 800 } }) })
    .resolve({ ...baseArgs, frameLayout: null });
  assert.equal(resized.record.status, 'stale:layout_changed');
});

test('켬: 위치가 없으면(사전 pending·none·없음) 기다리지 않고 지금과 같은 한 장', () => {
  for (const [entry, status] of [
    [{ status: SLIDE_LAYOUT_STATUS_MAP.pending, layout: null }, SPEECH_ROI_STATUS_MAP.layoutPending],
    [{ status: SLIDE_LAYOUT_STATUS_MAP.none, layout: null }, SPEECH_ROI_STATUS_MAP.noLayout],
    [{ status: SLIDE_LAYOUT_STATUS_MAP.missing, layout: null }, SPEECH_ROI_STATUS_MAP.noLayout],
  ]) {
    const result = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(entry), imageOps: fakeImageOps() })
      .resolve({ ...baseArgs, frameLayout: null });
    assert.ok(!(result instanceof Promise), '리졸버는 기다리지 않는다(동기)');
    assert.equal(result.zoomJpegBuffer, null, status);
    assert.equal(result.record.status, status);
  }
});

test('켬 + 맞지 않음: 한 장. 가리킴만 있는 지시 해설은 짝 스위치가 켜졌을 때만 [전체, 가리킴] 두 장', () => {
  const imageOps = fakeImageOps();
  const unmatched = { ...baseArgs, utterance: '이거 보시면 됩니다', anchor: '이거' };
  const none = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(), imageOps }).resolve(unmatched);
  assert.equal(none.zoomJpegBuffer, null);
  assert.equal(none.record.status, SPEECH_ROI_STATUS_MAP.noTerms);

  const pointingArgs = { ...unmatched, pointingRect: { x: 0.4, y: 0.4, w: 0.3, h: 0.3 }, regionFrame };
  const paired = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(), imageOps }).resolve(pointingArgs);
  assert.equal(paired.zoomJpegBuffer, regionFrame);
  assert.equal(paired.zoomKind, ZOOM_KIND_MAP.pointing);
  assert.equal(paired.record.zoomKind, ZOOM_KIND_MAP.pointing);
  assert.equal(imageOps.cropList.length, 0, '가리킴 그림은 렌더러가 잘라 보낸 것을 그대로 쓴다');

  const unpaired = createSpeechRoiResolver({ config: onConfig({ isSpeechRoiPointingPairEnabled: false }), layoutStore: layoutStoreOf(), imageOps })
    .resolve(pointingArgs);
  assert.equal(unpaired.zoomJpegBuffer, null);
  const valueType = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(), imageOps })
    .resolve({ ...pointingArgs, narrationType: 'interpretation', subKind: 'claim_to_value' });
  assert.equal(valueType.zoomJpegBuffer, null, '수치·척도는 가리킴 그림을 받지 않는다');
});

test('켬: 가리킴과 발화가 떨어져 있으면 발화 쪽을 확대하고 충돌을 기록, 가까우면 합친다', () => {
  const imageOps = fakeImageOps();
  const resolver = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(), imageOps });
  const apart = resolver.resolve({ ...baseArgs, pointingRect: { x: 0.75, y: 0.0, w: 0.2, h: 0.2 }, regionFrame });
  assert.equal(apart.zoomKind, ZOOM_KIND_MAP.speech);
  assert.equal(apart.record.pointingConflict, true);
  const merged = resolver.resolve({ ...baseArgs, pointingRect: { x: 0.1, y: 0.45, w: 0.25, h: 0.2 }, regionFrame });
  assert.equal(merged.zoomKind, ZOOM_KIND_MAP.merged);
  assert.equal(merged.record.pointingConflict, false);
});

test('켬: 대상이 둘인 해설(지시 완전형·둘째 주장)은 서로 다른 낱말로 맞은 줄 둘을 함께 확대한다', () => {
  const twoLineLayout = frameLayoutOf([
    ocrLine('서울 182억', { left: 128, top: 300, width: 120 }),
    ocrLine('부산 95억', { left: 300, top: 400, width: 120 }),
  ]);
  const args = { ...baseArgs, utterance: '서울이랑 부산 보시면', anchor: '', frameLayout: twoLineLayout };
  const resolver = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(), imageOps: fakeImageOps() });
  const complete = resolver.resolve({ ...args, subKind: 'complete' });
  assert.equal(complete.record.targetCount, 2);
  assert.equal(complete.record.isAmbiguous, false);
  const claim = resolver.resolve({ ...args, narrationType: 'interpretation', subKind: 'claim_to_value', mergedClaimCount: 1 });
  assert.equal(claim.record.targetCount, 2);
  const tooWide = resolver.resolve({
    ...args, subKind: 'complete', frameLayout: frameLayoutOf([ocrLine('서울 182억', { left: 64, top: 100 }), ocrLine('부산 95억', { left: 900, top: 600 })]),
  });
  assert.equal(tooWide.record.status, SPEECH_ROI_STATUS_MAP.used);
  assert.equal(tooWide.record.targetCount, 1, '합친 상자가 최대를 넘으면 첫째 대상만');
  const simple = resolver.resolve({ ...args, subKind: 'simple' });
  assert.equal(simple.record.isAmbiguous, false, '가까운 두 줄은 애매로 보지 않는다');
  assert.equal(simple.record.status, SPEECH_ROI_STATUS_MAP.used);
});

test('켬: 유형 목록에 없는 해설은 type_excluded, 척도는 scale 세부만', () => {
  const resolver = createSpeechRoiResolver({ config: onConfig({ speechRoiTypeList: ['deixis'] }), layoutStore: layoutStoreOf(), imageOps: fakeImageOps() });
  const excluded = resolver.resolve({ ...baseArgs, narrationType: 'interpretation', subKind: 'claim_to_value' });
  assert.equal(excluded.zoomJpegBuffer, null);
  assert.equal(excluded.record.status, SPEECH_ROI_STATUS_MAP.typeExcluded);
  const allTypes = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(), imageOps: fakeImageOps() });
  assert.ok(allTypes.resolve({ ...baseArgs, narrationType: 'visual_description', subKind: 'scale' }).zoomJpegBuffer);
  assert.equal(allTypes.resolve({ ...baseArgs, narrationType: 'visual_description', subKind: 'reaction' }).record.status, SPEECH_ROI_STATUS_MAP.typeExcluded);
});

test('켬: 자르기에 실패하면 crop_failed 로 남기고 확대 없이 간다', () => {
  const result = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(), imageOps: fakeImageOps({ cropResult: null }) }).resolve(baseArgs);
  assert.equal(result.zoomJpegBuffer, null);
  assert.equal(result.record.status, SPEECH_ROI_STATUS_MAP.cropFailed);
});

test('켬: 사전·자모 유사로 맞았으면 프롬프트에 넣는 낱말을 비운다(틀린 연결을 문장으로 굳히지 않는다)', () => {
  const result = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(), imageOps: fakeImageOps() }).resolve({
    ...baseArgs, utterance: '여기 매출 보시면', frameLayout: frameLayoutOf([ocrLine('Revenue 182억')]),
  });
  assert.equal(result.record.matchKind, 'alias');
  assert.equal(result.record.term, '매출');
  assert.equal(result.zoomTerm, null);
});

test('켬: 지시 전용 같은 프레임 OCR 스위치는 지시 유형이 켜져 있을 때만 시작 조건을 넓힌다', () => {
  const make = (extra) => createSpeechRoiResolver({ config: onConfig(extra), layoutStore: layoutStoreOf(), imageOps: fakeImageOps() });
  assert.equal(make({}).shouldStartFrameOcr(), false);
  assert.equal(make({ isSpeechRoiFrameOcrEnabled: true }).shouldStartFrameOcr(), true);
  assert.equal(make({ isSpeechRoiFrameOcrEnabled: true, speechRoiTypeList: ['interpretation'] }).shouldStartFrameOcr(), false);
});

test('판단 뒤 기다리지 않음: 끝나지 않은 같은 프레임 OCR 은 peekLayout 이 바로 null, 끝나면 원 줄 위치를 준다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let resolveOcr;
  const ocrClient = { recognize: () => new Promise((resolve) => { resolveOcr = resolve; }) };
  const task = createScreenTextGrounding({ ocrClient }).start({ jpegBuffer: screenFrame });
  assert.equal(task.peekLayout(), null);
  resolveOcr({ text: '', lineList: [ocrLine('서울 182억', { score: 0.5 })], meanScore: 0.5, verticalBoxRatio: 0, imageWidth: 1280, imageHeight: 720 });
  await new Promise((resolve) => { setImmediate(resolve); });
  const layout = task.peekLayout();
  assert.equal(layout.lineList.length, 1, '평균 점수 문턱 없이 줄 위치를 준다');
  assert.equal(layout.imageWidth, 1280);
  assert.equal(task.peekFrameText(), null, '값 검사 글자는 지금처럼 평균 점수 문턱을 따른다');
  mock.timers.reset();
});

test('peekLayout: 세로 글씨 비율 0.2 이상·실패·꺼짐이면 null', async () => {
  const vertical = createScreenTextGrounding({
    ocrClient: { recognize: async () => ({ text: '', lineList: [ocrLine('서울')], meanScore: 0.9, verticalBoxRatio: 0.3, imageWidth: 1280, imageHeight: 720 }) },
  }).start({ jpegBuffer: screenFrame });
  await vertical.waitForPrompt();
  assert.equal(vertical.peekLayout(), null);
  const failed = createScreenTextGrounding({ ocrClient: { recognize: async () => { throw new Error('x'); } } }).start({ jpegBuffer: screenFrame });
  await failed.waitForPrompt();
  assert.equal(failed.peekLayout(), null);
  assert.equal(createScreenTextGrounding({ ocrClient: {}, isEnabled: () => false }).start({ jpegBuffer: screenFrame }).peekLayout(), null);
});

// ── 에이전트: VLM 요청 ──

function installFetch(content = '{"seen":"서울 지역 표","caption":"서울 지역 표"}') {
  const bodyList = [];
  globalThis.fetch = async (_url, init) => {
    bodyList.push(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return bodyList;
}
const vlmConfig = { vlmUrl: 'http://x', vlmModel: 'm', vlmMaxSoftTokens: null };
const imageUrlOf = (buffer) => `data:image/jpeg;base64,${buffer.toString('base64')}`;
const NULL_ZOOM_ARGS = { zoomJpegBuffer: null, zoomKind: null, zoomTerm: null };

const agentCaseList = [
  ['지시(영역 없음)', () => createDeixisResolutionAgent({ config: vlmConfig }), { utterance: '여기 서울 지역 보시면', subKind: 'simple' }],
  ['지시(영역 있음)', () => createDeixisResolutionAgent({ config: vlmConfig }), { utterance: '여기 서울 지역 보시면', subKind: 'complete', hasPointingRegion: true, pointingOrderHint: '1) 왼쪽' }],
  ['수치', () => createInterpretiveBridgeAgent({ config: vlmConfig }), { utterance: '서울이 크게 늘었습니다', subKind: 'claim_to_value', screenLineList: [{ text: '서울 182억' }] }],
  ['척도', () => createVisualDescriptionAgent({ config: vlmConfig }), { utterance: '이 탑 정말 크죠', subKind: 'scale', screenLineList: [{ text: '높이 120m' }] }],
];

test('꺼짐(확대 없음): 지시(영역 있음·없음)·수치·척도 요청 몸통이 확대 인자를 넣기 전과 바이트까지 같다', async () => {
  for (const [name, makeAgent, args] of agentCaseList) {
    const bodyList = installFetch();
    await makeAgent().generate({ jpegBuffer: screenFrame, ...args });
    await makeAgent().generate({ jpegBuffer: screenFrame, ...args, ...NULL_ZOOM_ARGS });
    await makeAgent().generate({ jpegBuffer: screenFrame, ...args, zoomKind: 'speech', zoomTerm: '서울' });
    assert.equal(bodyList.length, 3, name);
    assert.equal(bodyList[1], bodyList[0], name);
    assert.equal(bodyList[2], bodyList[0], `${name}: 그림 없이 종류·낱말만 오면 무시한다`);
    const body = JSON.parse(bodyList[0]);
    assert.equal(body.messages[0].content.filter((block) => block.type === 'image_url').length, 1, name);
    assert.doesNotMatch(body.messages[0].content.at(-1).text, /첫째 이미지|둘째 이미지/, name);
  }
});

test('꺼짐(확대 없음): 프롬프트 첫 줄과 글이 지금과 같다', () => {
  for (const hasPointingRegion of [false, true]) {
    const base = buildGroundingPrompt({ utterance: '여기', maxChars: 60, subKind: 'simple', hasPointingRegion });
    assert.equal(buildGroundingPrompt({ utterance: '여기', maxChars: 60, subKind: 'simple', hasPointingRegion, zoomKind: null, zoomTerm: '서울' }), base);
  }
  assert.equal(buildInterpretationPrompt({ utterance: '늘었다', subKind: 'claim_to_value', zoomKind: null }), buildInterpretationPrompt({ utterance: '늘었다', subKind: 'claim_to_value' }));
  assert.equal(buildVisualDescriptionPrompt({ utterance: '크죠', subKind: 'scale', zoomKind: null }), buildVisualDescriptionPrompt({ utterance: '크죠', subKind: 'scale' }));
  assert.ok(buildInterpretationPrompt({ utterance: '늘었다' }).startsWith('이 이미지는 회의에서 공유 중인 화면이다.\n'));
});

test('켬 + 맞음: 해설당 VLM 1회, 이미지 2장 순서 [전체, 확대], 두 장 안내와 발화 낱말이 프롬프트에 들어간다', async () => {
  const roiResult = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(), imageOps: fakeImageOps() }).resolve(baseArgs);
  const zoomArgs = buildZoomAgentArgs({ roiResult, screenFrame });
  for (const [name, makeAgent, args] of agentCaseList) {
    const bodyList = installFetch();
    await makeAgent().generate({ jpegBuffer: regionFrame, ...args, ...zoomArgs });
    assert.equal(bodyList.length, 1, name);
    const content = JSON.parse(bodyList[0]).messages[0].content;
    assert.deepEqual(content.slice(0, 2).map((block) => block.image_url.url), [imageUrlOf(screenFrame), imageUrlOf(roiResult.zoomJpegBuffer)], name);
    assert.equal(content.length, 3, name);
    const prompt = content[2].text;
    assert.ok(prompt.startsWith('첫째 이미지는 회의에서 공유 중인 화면 전체다.\n'), name);
    assert.match(prompt, /둘째 이미지는 같은 순간 그 화면에서 발화에 나온 "서울"에 해당하는 글자가 있는 곳 둘레를 확대한 것이다/, name);
    assert.match(prompt, /이미지가 두 장이라는 것, 확대했다는 것은 출력에 쓰지 않는다/, name);
    assert.doesNotMatch(prompt, /이 이미지는/, name);
  }
});

test('켬 + 맞음: 지시 프롬프트에는 위치를 찾는 데 쓴 OCR 줄 글이 들어가지 않는다', async () => {
  const roiResult = createSpeechRoiResolver({ config: onConfig(), layoutStore: layoutStoreOf(), imageOps: fakeImageOps() }).resolve(baseArgs);
  const bodyList = installFetch();
  await createDeixisResolutionAgent({ config: vlmConfig }).generate({
    jpegBuffer: regionFrame, utterance: baseArgs.utterance, subKind: 'simple', hasPointingRegion: true,
    ...buildZoomAgentArgs({ roiResult, screenFrame }),
  });
  const prompt = JSON.parse(bodyList[0]).messages[0].content.at(-1).text;
  assert.doesNotMatch(prompt, /182억|부산|RSU|79개|글자 인식기/);
  assert.doesNotMatch(prompt, /가리킨 영역을 확대한 것이다/, '두 장일 때 첫 줄은 두 장 안내로 바뀐다');
});

test('켬: 가리킴 짝·합침 안내 문장', () => {
  const pointing = buildGroundingPrompt({ utterance: '여기', maxChars: 60, subKind: 'simple', hasPointingRegion: true, zoomKind: 'pointing' });
  assert.match(pointing, /둘째 이미지는 같은 순간 그 화면에서 발표자가 방금 필기하거나 포인터로 가리킨 영역을 확대한 것이다/);
  const merged = buildGroundingPrompt({ utterance: '여기', maxChars: 60, subKind: 'simple', hasPointingRegion: true, zoomKind: 'merged', zoomTerm: '서울' });
  assert.match(merged, /가리킨 영역과 발화에 나온 "서울"에 해당하는 글자가 있는 곳 둘레를 확대한 것이다/);
  const noTerm = buildGroundingPrompt({ utterance: '여기', maxChars: 60, subKind: 'simple', zoomKind: 'speech', zoomTerm: null });
  assert.match(noTerm, /발화에 나온 대상의 이름이 적힌 곳 둘레를 확대한 것이다/);
  const value = buildInterpretationPrompt({ utterance: '늘었다', subKind: 'claim_to_value', zoomKind: 'speech', zoomTerm: '서울' });
  assert.match(value, /어느 값이 어느 항목의 것인지는 첫째 이미지의 배치로 확인한다/);
  assert.doesNotMatch(pointing, /어느 값이 어느 항목의 것인지는 첫째 이미지/);
});

test('척도 아닌 시각 묘사(반응·무발화)는 확대 인자가 와도 한 장', async () => {
  const bodyList = installFetch('{"description":"사진"}');
  await createVisualDescriptionAgent({ config: vlmConfig }).generate({
    jpegBuffer: screenFrame, subKind: 'reaction', zoomJpegBuffer: Buffer.from('zoom'), zoomKind: 'speech', zoomTerm: '서울',
  });
  const content = JSON.parse(bodyList[0]).messages[0].content;
  assert.equal(content.filter((block) => block.type === 'image_url').length, 1);
});

// ── main 배선(소스 검사) ──

test('pipeline-deixis: 판단·OCR 대기 뒤 발화 ROI 를 정하고, 확대가 있을 때만 에이전트 인자를 바꾸고, 기록에 남긴다', () => {
  const source = readSource('src/main/caption-pipeline/index.js');
  const start = source.indexOf("ipcMain.handle('pipeline-deixis'");
  const body = source.slice(start, source.indexOf("ipcMain.handle('pipeline-command'", start));
  assert.match(body, /^ipcMain\.handle\('pipeline-deixis', async \(_event, \{[^}]*pointingRect = null[^}]*\}\)/);
  const waitAt = body.indexOf('await screenTextPromise');
  const resolveAt = body.indexOf('speechRoi.resolve({');
  const generateAt = body.indexOf('await agent.generate(');
  assert.ok(waitAt > 0 && resolveAt > waitAt && generateAt > resolveAt);
  assert.match(body, /frameLayout: screenTextTask\?\.peekLayout\(\) \?\? null/);
  assert.match(body, /\.\.\.buildZoomAgentArgs\(\{ roiResult: speechRoiResult, screenFrame: frameSet\.screenFrame \}\)/);
  assert.match(body, /speechRoiResult\.record \? \{ speechRoi: speechRoiResult\.record \} : \{\}/);
  assert.match(body, /speechRoi\.shouldStartFrameOcr\(\)/);
});

test('전환 때 위치 사전: 켜졌을 때만 같은 JPEG 로 채우고, 세션 시작 때 비운다', () => {
  const source = readSource('src/main/caption-pipeline/index.js');
  const slideTextStart = source.indexOf("ipcMain.handle('pipeline-slide-text'");
  const slideTextBody = source.slice(slideTextStart, source.indexOf("ipcMain.handle('embed-frame'", slideTextStart));
  assert.match(slideTextBody, /slideTextStore\.ensure\(\{ slideLabel, jpegBuffer \}\)/);
  assert.match(slideTextBody, /if \(speechRoi\.isEnabled\(\)\) slideLayoutStore\.ensure\(\{ slideLabel, jpegBuffer \}\)/);
  const sessionStart = source.indexOf("ipcMain.handle('pipeline-session-start'");
  assert.match(source.slice(sessionStart, source.indexOf("ipcMain.handle('pipeline-session-end'", sessionStart)), /slideLayoutStore\.reset\(\);/);
  assert.match(source, /createSlideTextAgent\(\{\s*config, ocrClient: sharedOcrClient,/);
});

// ── 렌더러·preload: 가리킨 영역 좌표 ──

test('렌더러: 가리킨 영역 비율 상자에 자른 그림과 같은 여백을 더해 화면 안으로 자른다', () => {
  assert.deepEqual(toPointingRect({ subRegion: { x: 0.5, y: 0.25, w: 0.1, h: 0.2 }, margin: 0.12 }), { x: 0.38, y: 0.13, w: 0.34, h: 0.44 });
  const clamped = toPointingRect({ subRegion: { x: 0.02, y: 0.9, w: 0.1, h: 0.1 }, margin: 0.12 });
  assert.deepEqual(clamped, { x: 0, y: 0.78, w: 0.24, h: 0.22 });
  assert.equal(toPointingRect({ subRegion: null, margin: 0.12 }), null);
});

test('렌더러: 지시 판정은 잘린 그림이 있을 때만 그 영역 비율 상자를 pointingRect 로 보낸다', () => {
  const source = readSource('src/renderer/app/main.js');
  const start = source.indexOf('async function runDeixisDecision(');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /const pointingRect = fullBuffer\s*\? toPointingRect\(\{ subRegion: firedDecision\.region, margin: POINTING_CROP_MARGIN \}\) : null;/);
  assert.match(body, /window\.seeon\.sendPipelineDeixis\(\{\s*ts, buffer, fullBuffer, [\s\S]*pointingRect,[\s\S]*\}\)/);
});

function loadViewerPreload() {
  const invokeList = [];
  let seeon = null;
  const originalLoad = Module._load;
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { if (name === 'seeon') seeon = api; } },
    ipcRenderer: {
      on() {}, send() {}, sendSync: () => null, removeListener() {}, removeAllListeners() {},
      invoke: (channel, payload) => { invokeList.push({ channel, payload }); return Promise.resolve(null); },
    },
  };
  Module._load = function loadWithFakeElectron(request, ...argList) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, ...argList);
  };
  try {
    delete require.cache[require.resolve('../src/preload/viewer.js')];
    require('../src/preload/viewer.js');
  } finally {
    Module._load = originalLoad;
  }
  return { seeon, invokeList };
}

test('preload: pointingRect 를 그대로 넘기고, 없으면 null', async () => {
  const { seeon, invokeList } = loadViewerPreload();
  const pointingRect = { x: 0.38, y: 0.13, w: 0.34, h: 0.44 };
  await seeon.sendPipelineDeixis({ ts: 1, buffer: new Uint8Array([1]).buffer, fullBuffer: new Uint8Array([2]).buffer, utterance: '여기', recentTranscript: '', hasPointingRegion: true, pointingRect });
  await seeon.sendPipelineDeixis({ ts: 2, buffer: new Uint8Array([1]).buffer, utterance: '여기', recentTranscript: '' });
  assert.deepEqual(invokeList[0].payload.pointingRect, pointingRect);
  assert.equal(invokeList[1].payload.pointingRect, null);
});
