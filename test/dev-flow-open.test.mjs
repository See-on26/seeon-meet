import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import { createLogoTapCounter, LOGO_TAP_MAP } from '../src/renderer/core/dev/logo-tap-counter.js';

const require = createRequire(import.meta.url);
const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

// 기술 스택 점검표 댓글 #20: 로고를 연달아 누르면 개발자 모드(파이프라인 흐름 창)를 연다. 댓글은 10번, 사용자가 줄여 2초 안에 5번.
test('로고를 2초 안에 5번 누르면 연다', () => {
  assert.deepEqual(LOGO_TAP_MAP, { count: 5, windowMs: 2000 });
  const clock = { ms: 0 };
  const counter = createLogoTapCounter({ now: () => clock.ms });
  const resultList = [];
  for (let index = 0; index < 5; index += 1) {
    resultList.push(counter.tap());
    clock.ms += 400;
  }
  assert.deepEqual(resultList, [false, false, false, false, true]);
});

test('5번째가 첫 누름에서 2초를 넘기면 열지 않고, 연 뒤에는 다시 처음부터 센다', () => {
  const clock = { ms: 0 };
  const counter = createLogoTapCounter({ now: () => clock.ms });
  for (let index = 0; index < 4; index += 1) {
    counter.tap();
    clock.ms += 600;
  }
  assert.equal(counter.tap(), false, '첫 누름에서 2.4초 뒤 다섯 번째');
  clock.ms += 100;
  assert.equal(counter.tap(), true, '0.6~2.5초의 5번은 최근 2초 안이라 연다');
  assert.equal(counter.tap(), false, '열고 나면 처음부터 센다');
});

test('제품 화면은 로고 연타로 흐름 창을 열고, 두 재생기에 재생 시작 알림을 넘겨 main 에 알린다', () => {
  const html = readSource('src/renderer/app/index.html');
  assert.match(html, /<span class="logo" id="brandLogo">SEE-ON<\/span>/);
  const source = readSource('src/renderer/app/main.js');
  assert.match(source, /createLogoTapCounter/);
  assert.match(source, /\$\('brandLogo'\)\.addEventListener\('click'/);
  assert.match(source, /window\.seeon\.openDevFlow\(\)/);
  assert.equal((source.match(/onPlayStart: reportNarrationPlayStart,/g) || []).length, 2);
  assert.match(source, /window\.seeon\.reportNarrationPlayback\(report\);/);
});

function loadViewerPreloadWithFakeElectron() {
  const fake = { exposedMap: {}, sentList: [], invokedList: [] };
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { fake.exposedMap[name] = api; } },
    ipcRenderer: {
      send: (channel, payload) => fake.sentList.push([channel, payload]),
      invoke: (channel, payload) => { fake.invokedList.push([channel, payload]); return Promise.resolve({ isOk: true }); },
      on() {}, sendSync: () => null, removeListener() {}, removeAllListeners() {},
    },
  };
  const originalLoad = Module._load;
  Module._load = function loadWithFakeElectron(request, ...argList) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, ...argList);
  };
  try {
    delete require.cache[require.resolve('../src/preload/viewer.js')];
    require('../src/preload/viewer.js');
    delete require.cache[require.resolve('../src/preload/dev-flow.js')];
    require('../src/preload/dev-flow.js');
  } finally {
    Module._load = originalLoad;
  }
  return fake;
}

test('viewer preload 는 재생 시작 알림을 main 으로 보내고 흐름 창 열기를 요청하며, 흐름 창 preload 는 갱신을 받는다', async () => {
  const fake = loadViewerPreloadWithFakeElectron();
  fake.exposedMap.seeon.reportNarrationPlayback({ entry: { text: '해설', ts: 1 }, durationMs: 900, wallMs: 5 });
  await fake.exposedMap.seeon.openDevFlow();
  assert.deepEqual(fake.sentList.at(-1), ['pipeline-narration-playback', { entry: { text: '해설', ts: 1 }, durationMs: 900, wallMs: 5 }]);
  assert.deepEqual(fake.invokedList.at(-1), ['dev-flow-open', undefined]);
  assert.equal(typeof fake.exposedMap.devFlow.onUpdate, 'function');
  assert.match(readSource('src/renderer/dev-flow/flow.js'), /window\.devFlow\.onUpdate\(render\)/);
});
