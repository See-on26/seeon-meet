import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import { captureDeixisFrameSet } from '../src/renderer/core/capture/deixis-frame-set.js';

const require = createRequire(import.meta.url);
const { resolveDeixisFrameSet } = require('../src/main/caption-pipeline/orchestrator/deixis-frame-set.js');
const { NARRATION_TYPE_MAP } = require('../src/main/caption-pipeline/contracts/narration-types.js');

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const regionBytes = new Uint8Array([1, 2, 3]);
const screenBytes = new Uint8Array([9, 8, 7, 6]);

// main: 어느 에이전트가 어느 그림을 받는가

test('가리킨 영역이 있으면 지시 에이전트만 잘린 그림을, 수치·척도 에이전트는 전체 화면을 받는다', () => {
  const frameSet = resolveDeixisFrameSet({ buffer: regionBytes, fullBuffer: screenBytes });
  assert.deepEqual([...frameSet.selectAgentFrame(NARRATION_TYPE_MAP.deixis)], [...regionBytes]);
  assert.deepEqual([...frameSet.selectAgentFrame(NARRATION_TYPE_MAP.interpretation)], [...screenBytes]);
  assert.deepEqual([...frameSet.selectAgentFrame(NARRATION_TYPE_MAP.visualDescription)], [...screenBytes]);
  assert.ok(Buffer.isBuffer(frameSet.selectAgentFrame(NARRATION_TYPE_MAP.deixis)));
  assert.ok(Buffer.isBuffer(frameSet.screenFrame));
});

test('수치 해설의 같은 프레임 OCR 근거와 값 검사 재전사가 쓰는 그림은 전체 화면이다', () => {
  const frameSet = resolveDeixisFrameSet({ buffer: regionBytes, fullBuffer: screenBytes });
  assert.deepEqual([...frameSet.screenFrame], [...screenBytes]);
  assert.equal(frameSet.screenFrame, frameSet.selectAgentFrame(NARRATION_TYPE_MAP.interpretation));
});

test('영역이 없으면(전체 화면 한 장) 지시·수치·척도 에이전트와 OCR 이 그 한 장을 함께 쓴다', () => {
  for (const fullBuffer of [undefined, null]) {
    const frameSet = resolveDeixisFrameSet({ buffer: screenBytes, fullBuffer });
    assert.deepEqual([...frameSet.screenFrame], [...screenBytes]);
    for (const narrationType of [NARRATION_TYPE_MAP.deixis, NARRATION_TYPE_MAP.interpretation, NARRATION_TYPE_MAP.visualDescription]) {
      assert.equal(frameSet.selectAgentFrame(narrationType), frameSet.screenFrame, narrationType);
    }
  }
});

test('수치·척도가 아닌 유형(지시 에이전트로 넘어가는 유형)은 잘린 그림을 받는다', () => {
  const frameSet = resolveDeixisFrameSet({ buffer: regionBytes, fullBuffer: screenBytes });
  assert.deepEqual([...frameSet.selectAgentFrame(undefined)], [...regionBytes]);
  assert.deepEqual([...frameSet.selectAgentFrame('unknown')], [...regionBytes]);
});

test('pipeline-deixis 처리기는 전체 화면을 받아 OCR·에이전트·값 검사 재전사에 나눠 주고, 영역 표시는 그대로 넘긴다', () => {
  const source = readSource('src/main/caption-pipeline/index.js');
  const start = source.indexOf("ipcMain.handle('pipeline-deixis'");
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf("ipcMain.handle('pipeline-command'", start));
  assert.match(body, /^ipcMain\.handle\('pipeline-deixis', async \(_event, \{ ts, buffer, fullBuffer = null, /);
  assert.match(body, /const frameSet = resolveDeixisFrameSet\(\{ buffer, fullBuffer \}\);/);
  assert.match(body, /screenTextGrounding\.start\(\{ jpegBuffer: frameSet\.screenFrame \}\)/);
  assert.match(body, /jpegBuffer: frameSet\.selectAgentFrame\(narrationType\),/);
  assert.match(body, /slideTextAgent\.transcribeWithVlm\(\{ jpegBuffer: frameSet\.screenFrame \}\)/);
  assert.doesNotMatch(body, /Buffer\.from\(buffer\)/);
  assert.match(body, /\[NARRATION_TYPE_MAP\.deixis\]: \{ hasPointingRegion, pointingOrderHint \}/);
  assert.match(body, /sendCaption\(\{[^}]*hasPointingRegion,/);
});

// 렌더러: 무엇을 찍어 어떤 모양으로 보내는가

function makeCaptureRecorder() {
  const callList = [];
  return {
    callList,
    captureRegion: async (rect) => { callList.push(rect); return rect.isNarrowed ? 'region-jpeg' : 'screen-jpeg'; },
  };
}
const frame = { x: 100, y: 40, w: 1280, h: 720 };
const subRegion = { x: 0.5, y: 0.25, w: 0.1, h: 0.2 };
const narrowRegion = (base, sub) => ({ ...base, sub, isNarrowed: true });

test('가리킨 영역이 있으면 잘린 그림과 같은 순간의 전체 화면을 함께 찍는다(기다림 없이 이어서 그린다)', async () => {
  const recorder = makeCaptureRecorder();
  const pending = captureDeixisFrameSet({ frame, subRegion, narrowRegion, captureRegion: recorder.captureRegion });
  assert.equal(recorder.callList.length, 2);
  assert.deepEqual(recorder.callList, [narrowRegion(frame, subRegion), frame]);
  assert.deepEqual(await pending, { buffer: 'region-jpeg', fullBuffer: 'screen-jpeg' });
});

test('영역이 없으면 지금처럼 전체 화면 한 장만 찍고 fullBuffer 는 없다', async () => {
  const recorder = makeCaptureRecorder();
  const frameSet = await captureDeixisFrameSet({ frame, subRegion: null, narrowRegion, captureRegion: recorder.captureRegion });
  assert.deepEqual(recorder.callList, [frame]);
  assert.deepEqual(frameSet, { buffer: 'screen-jpeg', fullBuffer: null });
});

test('공유 화면 좌표가 없으면 아무것도 찍지 않는다', async () => {
  const recorder = makeCaptureRecorder();
  const frameSet = await captureDeixisFrameSet({ frame: null, subRegion, narrowRegion, captureRegion: recorder.captureRegion });
  assert.deepEqual(recorder.callList, []);
  assert.deepEqual(frameSet, { buffer: null, fullBuffer: null });
});

function loadViewerPreload() {
  const exposedMap = {};
  const invokeList = [];
  const originalLoad = Module._load;
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposedMap[name] = api; } },
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
  return { seeon: exposedMap.seeon, invokeList };
}

test('viewer preload 는 전체 화면을 fullBuffer(Uint8Array)로 함께 보내고, 없으면 null 로 보낸다', async () => {
  const { seeon, invokeList } = loadViewerPreload();
  await seeon.sendPipelineDeixis({
    ts: 1, buffer: regionBytes.buffer, fullBuffer: screenBytes.buffer, utterance: '여기', recentTranscript: '', hasPointingRegion: true,
  });
  await seeon.sendPipelineDeixis({ ts: 2, buffer: screenBytes.buffer, utterance: '여기', recentTranscript: '' });
  assert.equal(invokeList[0].channel, 'pipeline-deixis');
  assert.ok(invokeList[0].payload.fullBuffer instanceof Uint8Array);
  assert.deepEqual([...invokeList[0].payload.buffer], [...regionBytes]);
  assert.deepEqual([...invokeList[0].payload.fullBuffer], [...screenBytes]);
  assert.equal(invokeList[0].payload.hasPointingRegion, true);
  assert.equal(invokeList[1].payload.fullBuffer, null);
  assert.equal(invokeList[1].payload.hasPointingRegion, false);
});

test('제품 화면은 지시 판정 때 자리 잡기를 기다려 두 그림을 찍고, 잘린 그림과 전체 화면을 함께 보낸다', () => {
  const source = readSource('src/renderer/app/main.js');
  assert.match(source, /captureWhenSettled\(\{\s*isSettling: \(\) => roiStore\.isLayoutSettling\(\),\s*capture: \(\) => captureDeixisFrameSet\(\{\s*frame: getFrameRegionPx\(\), subRegion, narrowRegion: narrowToPointingRegion, captureRegion: captureRegionJpeg,\s*\}\),\s*\}\)/);
  const start = source.indexOf('async function runDeixisDecision(');
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /const \[\{ buffer, fullBuffer \}, decision\] = await Promise\.all\(\[\s*captureDeixisFrameSetWhenSettled\(firedDecision\.region\),/);
  assert.match(body, /window\.seeon\.sendPipelineDeixis\(\{\s*ts, buffer, fullBuffer, /);
  assert.match(body, /hasPointingRegion: Boolean\(region\)/);
});
