import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import { computeWordBudget, MODE_MAP, NARRATION_WORD_RANGE_MAP } from '../src/renderer/core/mode/mode-policy.js';

const require = createRequire(import.meta.url);

function readSource(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function readFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, signature);
  return source.slice(start, source.indexOf('\n}\n', start));
}

function loadViewerPreload() {
  const exposedMap = {};
  const invokeList = [];
  const originalLoad = Module._load;
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposedMap[name] = api; } },
    ipcRenderer: {
      on() {}, send() {},
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

test('화면 변화 해설 어절 범위는 새 글자·강조 3~8, 새 슬라이드 4~10 이다', () => {
  assert.deepEqual(NARRATION_WORD_RANGE_MAP.screen_change, {
    new_text: { minWordCount: 3, maxWordCount: 8 },
    highlight: { minWordCount: 3, maxWordCount: 8 },
    new_slide: { minWordCount: 4, maxWordCount: 10 },
  });
  const budget = computeWordBudget({ mode: MODE_MAP.delayed, narrationType: 'screen_change', subKind: 'new_text' });
  assert.equal(budget.isDroppable, false);
  assert.equal(budget.maxWordCount, 8);
});

test('preload 는 화면 변화 사건과 기준 화면을 Uint8Array 로 보내고, 지시 판정 화면을 찍은 시각을 함께 넘긴다', async () => {
  const { seeon, invokeList } = loadViewerPreload();
  await seeon.sendScreenChange({
    ts: 1, slideLabel: '2', buffer: new Uint8Array([1, 2]).buffer, vlmBuffer: new Uint8Array([3]).buffer,
    regionNorm: { x: 0, y: 0, w: 0.1, h: 0.1 }, firstSeenTs: 0, firstSeenVideoTimeMs: 100,
  });
  await seeon.sendScreenChange({ ts: 2, slideLabel: '2', buffer: new Uint8Array([4]).buffer });
  await seeon.sendScreenChangeBaseline({ ts: 3, slideLabel: '2', buffer: new Uint8Array([5]).buffer, isSlideStart: true, slideStartTs: 0 });
  await seeon.sendPipelineDeixis({ ts: 4, buffer: new Uint8Array([6]).buffer, utterance: '여기', recentTranscript: '', frameTs: 3 });
  assert.equal(invokeList[0].channel, 'pipeline-screen-change');
  assert.ok(invokeList[0].payload.buffer instanceof Uint8Array);
  assert.deepEqual([...invokeList[0].payload.vlmBuffer], [3]);
  assert.equal(invokeList[1].payload.vlmBuffer, null);
  assert.equal(invokeList[2].channel, 'pipeline-screen-change-baseline');
  assert.equal(invokeList[2].payload.isSlideStart, true);
  assert.equal(invokeList[3].payload.frameTs, 3);
});

test('제품 화면은 화면 변화 모드가 off 면 감지기를 만들지 않는다', () => {
  const source = readSource('src/renderer/app/main.js');
  const body = readFunctionBody(source, 'async function attemptStartExperiment(');
  assert.match(body, /screenChangeSession = screenChangeMode && screenChangeMode !== SCREEN_CHANGE_MODE_OFF \? sessionResult\.screenChange : null;/);
  assert.match(body, /screenChangeDetector = screenChangeSession \? createScreenChangeDetector\(\) : null;/);
  assert.match(readFunctionBody(source, 'function sampleScreenChange('), /if \(!screenChangeDetector\) return;/);
});

test('표본마다 가리킴 움직임 뒤에 화면 변화 감지기를 돌리고, 새·재방문 슬라이드 확정이면 조용 구간 기준을 다시 잡는다', () => {
  const source = readSource('src/renderer/app/main.js');
  assert.match(readFunctionBody(source, 'function samplePointingFrame('), /attachPointingMotion\(\);\n {2}sampleScreenChange\(\{ imageData, ts \}\);/);
  const confirmBody = readFunctionBody(source, 'async function confirmSlideCandidate(');
  assert.match(confirmBody, /if \(!decision\.isNew && !decision\.isRevisit\) return;[\s\S]*screenChangeDetector\?\.setBaseline\(\{ ts: performance\.now\(\), isSlideStart: true \}\);/);
  const sampleBody = readFunctionBody(source, 'function sampleScreenChange(');
  assert.match(sampleBody, /excludedCellMask: pointingLocator\.findConstantChangeCells\(\{ nowTs: ts \}\)/);
  assert.match(sampleBody, /isPointingActive: pointingMotionTracker\.isMoving\(\{ nowTs: ts \}\)/);
  assert.match(sampleBody, /isConfirming: isConfirmingSlide/);
  assert.match(readFunctionBody(source, 'function syncRoiGeneration('), /screenChangeDetector\?\.reset\(\);/);
});
