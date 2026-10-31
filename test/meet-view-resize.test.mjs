import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function readFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} 없음`);
  return source.slice(start, source.indexOf('\n}\n', start));
}

function requireWithFakeModuleMap({ path, fakeModuleMap }) {
  const originalLoad = Module._load;
  Module._load = function loadWithFakeModule(request, ...argList) {
    if (Object.hasOwn(fakeModuleMap, request)) return fakeModuleMap[request];
    return originalLoad.call(this, request, ...argList);
  };
  try {
    delete require.cache[require.resolve(path)];
    require(path);
  } finally {
    Module._load = originalLoad;
  }
}

test('viewer preload 는 main 이 보낸 Meet 화면 크기 변경을 onMeetViewResized 로 넘긴다', () => {
  const exposedMap = {};
  const listenerMap = {};
  requireWithFakeModuleMap({
    path: '../src/preload/viewer.js',
    fakeModuleMap: {
      electron: {
        contextBridge: { exposeInMainWorld: (name, api) => { exposedMap[name] = api; } },
        ipcRenderer: {
          on: (channel, handler) => { listenerMap[channel] = handler; },
          send() {}, invoke: () => Promise.resolve(null), sendSync: () => null, removeListener() {}, removeAllListeners() {},
        },
      },
    },
  });
  const receivedList = [];
  exposedMap.seeon.onMeetViewResized((payload) => receivedList.push(payload));
  listenerMap['meet-view-resized']({}, { width: 1464, height: 842 });
  assert.deepEqual(receivedList, [{ width: 1464, height: 842 }]);
});

// Meet preload 는 문서·창·타이머를 전역으로 쓴다. 가짜 전역을 잠깐 깔고 불러 크기 변경 뒤 다시 재는 시점을 본다.
function loadMeetingPreload() {
  const timerList = [];
  let nextId = 1;
  const windowListenerMap = {};
  const sentList = [];
  const fakeGlobalMap = {
    document: { readyState: 'complete', documentElement: {}, addEventListener() {} },
    window: { addEventListener: (type, handler) => { windowListenerMap[type] = handler; } },
    MutationObserver: class { observe() {} },
    setInterval: (fn, ms) => { timerList.push({ id: nextId, fn, ms, isRepeat: true }); nextId += 1; return nextId - 1; },
    setTimeout: (fn, ms) => { timerList.push({ id: nextId, fn, ms, isRepeat: false }); nextId += 1; return nextId - 1; },
    clearTimeout: (id) => {
      const index = timerList.findIndex((timer) => timer.id === id);
      if (index >= 0) timerList.splice(index, 1);
    },
  };
  const originalMap = Object.fromEntries(Object.keys(fakeGlobalMap).map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, fakeGlobalMap);
  const restore = () => {
    for (const [key, value] of Object.entries(originalMap)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
  try {
    requireWithFakeModuleMap({
      path: '../src/preload/meeting/index.js',
      fakeModuleMap: {
        electron: { ipcRenderer: { send: (channel, payload) => sentList.push([channel, payload]) } },
        './roi-scanner': { scanRois: () => ({ viewport: { vw: 1464, vh: 842, dpr: 2 }, roiList: [] }) },
      },
    });
  } catch (error) {
    restore();
    throw error;
  }
  return { timerList, windowListenerMap, sentList, restore };
}

test('Meet 화면 크기가 바뀌면 다음 폴링(500ms)을 기다리지 않고 150ms 뒤 좌표를 다시 잰다', () => {
  const { timerList, windowListenerMap, sentList, restore } = loadMeetingPreload();
  try {
    assert.deepEqual(timerList.map(({ ms, isRepeat }) => ({ ms, isRepeat })), [{ ms: 500, isRepeat: true }]);
    windowListenerMap.resize();
    const resizeTimer = timerList.find((timer) => !timer.isRepeat);
    assert.equal(resizeTimer.ms, 150);
    resizeTimer.fn();
    assert.deepEqual(sentList, [['roi-update', { viewport: { vw: 1464, vh: 842, dpr: 2 }, roiList: [] }]]);
  } finally {
    restore();
  }
});

test('크기가 연달아 바뀌면(창 끌기) 마지막 변경 뒤 한 번만 다시 잰다', () => {
  const { timerList, windowListenerMap, restore } = loadMeetingPreload();
  try {
    windowListenerMap.resize();
    windowListenerMap.resize();
    windowListenerMap.resize();
    assert.equal(timerList.filter((timer) => !timer.isRepeat).length, 1);
  } finally {
    restore();
  }
});

test('뷰어는 main 이 알린 Meet 화면 크기를 RoiStore 에 넘겨, 그 크기의 좌표가 자리 잡을 때까지 자르지 않게 한다', () => {
  const source = readSource('src/renderer/app/main.js');
  assert.match(source, /window\.seeon\.onMeetViewResized\(\(\{ width, height \}\) => \{[^}]*roiStore\.expectViewport\(\{ vw: width, vh: height \}\);/);
});

test('공유 화면 좌표가 바뀌면 감지기 기준은 늘 다시 잡고, 체류 판정 취소는 까닭(크기 변경이면 유지)에 따른다', () => {
  const source = readSource('src/renderer/app/main.js');
  const body = readFunctionBody(source, 'syncRoiGeneration');
  assert.match(body, /resolveRoiChangeReset\(\{ cause \}\)/);
  assert.match(body, /const cause = roiStore\.getLastChangeCause\(\);/);
  assert.match(body, /if \(shouldResetDwell\) slideDwellGate\.reset\(\);/);
  assert.equal((body.match(/slideDwellGate\.reset\(\)/g) || []).length, 1);
  for (const call of ['histogramGate.reset();', 'pointingLocator.reset();', 'roiChangeSuppressUntil = ts + ROI_CHANGE_SUPPRESS_MS;']) {
    assert.ok(body.includes(call), call);
  }
  assert.match(body, /reason: ROI_CHANGE_REASON_MAP\[cause\]/);
  assert.match(source, /\[ROI_CHANGE_CAUSE_MAP\.layout\]: 'Meet 화면 크기 변경 → 전환 감지기 다시 기준 잡기'/);
  assert.match(source, /\[ROI_CHANGE_CAUSE_MAP\.screen\]: 'ROI 좌표 변경 → 전환 감지기 리셋'/);
});
