import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSegmentSummaryScheduler } = require('../src/main/caption-pipeline/context/segment-summary-scheduler.js');
const { createContextStore, SEGMENT_STATUS_MAP } = require('../src/main/caption-pipeline/context/context-store.js');
const { buildSegmentMaterial } = require('../src/main/caption-pipeline/context/segment-material.js');
const { RECORD_KIND_MAP } = require('../src/main/caption-pipeline/instrumentation/record-store.js');
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');

// 구간마다 남기는 진행 로그가 시험 출력에 섞이지 않게 막는다.
beforeEach(() => mock.method(console, 'log', () => {}));
afterEach(() => mock.restoreAll());

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

function startStore({ sessionId = 's1', markList = [] } = {}) {
  const store = createContextStore();
  store.start({ sessionId, startedAt: 0 });
  applyMarkList({ store, markList });
  return store;
}

// markList: [[슬라이드 번호, 방문 시각], …]. 재료 없는 구간은 GPU 에 묻지 않으므로 방문마다 말 한 마디를 둔다.
function applyMarkList({ store, markList, hasSpeech = true }) {
  for (const [major, ts] of markList) {
    store.applyRecord({ kind: RECORD_KIND_MAP.slideMark, ts, slideLabel: String(major), frameKind: 'base' });
    if (hasSpeech) store.applyRecord({ kind: RECORD_KIND_MAP.asr, ts: ts + 500, text: `슬라이드 ${major} 이야기` });
  }
}

// summarize 를 부를 때마다 붙잡아 두고, 시험이 직접 resolve·reject 한다.
function createHeldAgent() {
  const callList = [];
  return {
    callList,
    agent: {
      summarize({ materialText, language }) {
        return new Promise((resolve, reject) => { callList.push({ materialText, language, resolve, reject }); });
      },
    },
  };
}

function statusOf({ store }) {
  return store.getSegmentSummaryList().map(({ key, status, text }) => [key, status, text]);
}

test('scheduler: 닫히고 settleMs 가 지난 구간만, 한 번에 하나씩 요약해 Store 에 넣는다', async () => {
  const store = startStore({ markList: [[1, 0], [2, 60000], [3, 120000]] });
  store.applyRecord({ kind: RECORD_KIND_MAP.asr, ts: 1000, text: '매출이 늘었습니다' });
  const { callList, agent } = createHeldAgent();
  let nowTs = 123000;
  const scheduler = createSegmentSummaryScheduler({
    contextStore: store, segmentSummaryAgent: agent, getCaptionLanguage: () => 'en', now: () => nowTs,
  });

  scheduler.poll();
  // 2@60000 은 닫힌 지 3초라 아직이고, 3@120000 은 지금 보는 화면이다.
  assert.deepEqual(statusOf({ store }), [['1@0', SEGMENT_STATUS_MAP.requested, '']]);
  assert.equal(callList.length, 1);
  assert.equal(callList[0].language, 'en');
  const segment = { key: '1@0', slideMajor: 1, startTs: 0, endTs: 60000, isRevisit: false, isOpenTail: false };
  assert.equal(callList[0].materialText, buildSegmentMaterial({ snapshot: store.snapshot(), segment }));
  assert.match(callList[0].materialText, /매출이 늘었습니다/);

  nowTs = 125000;
  scheduler.poll();
  assert.deepEqual(statusOf({ store }).map(([key]) => key), ['1@0', '2@60000']);
  assert.equal(callList.length, 1, '앞 구간이 끝나기 전에는 다음 구간을 보내지 않는다');

  callList[0].resolve({ text: '매출이 늘었다.' });
  await flush();
  assert.equal(callList.length, 2);
  callList[1].resolve({ text: '' });
  await flush();
  assert.deepEqual(statusOf({ store }), [
    ['1@0', SEGMENT_STATUS_MAP.ready, '매출이 늘었다.'],
    ['2@60000', SEGMENT_STATUS_MAP.ready, ''],
  ]);
});

test('scheduler: 이미 요청한 구간은 다시 요청하지 않는다', async () => {
  const store = startStore({ markList: [[1, 0], [2, 60000]] });
  const { callList, agent } = createHeldAgent();
  const scheduler = createSegmentSummaryScheduler({
    contextStore: store, segmentSummaryAgent: agent, getCaptionLanguage: () => 'ko', now: () => 70000,
  });
  scheduler.poll();
  scheduler.poll();
  assert.equal(callList.length, 1);
  callList[0].resolve({ text: '첫 화면 요약' });
  await flush();
  scheduler.poll();
  await flush();
  assert.equal(callList.length, 1);
  assert.deepEqual(statusOf({ store }), [['1@0', SEGMENT_STATUS_MAP.ready, '첫 화면 요약']]);
});

test('scheduler: reset 뒤 도착한 응답은 버린다', async () => {
  const store = startStore({ markList: [[1, 0], [2, 60000]] });
  const { callList, agent } = createHeldAgent();
  const scheduler = createSegmentSummaryScheduler({
    contextStore: store, segmentSummaryAgent: agent, getCaptionLanguage: () => 'ko', now: () => 70000,
  });
  scheduler.poll();
  assert.equal(callList.length, 1);

  // 정지 직후 다시 시작: 새 세션에도 같은 key(1@0)가 생긴다.
  scheduler.reset();
  store.start({ sessionId: 's2', startedAt: 0 });
  applyMarkList({ store, markList: [[1, 0], [2, 60000]] });
  scheduler.poll();
  assert.deepEqual(statusOf({ store }), [['1@0', SEGMENT_STATUS_MAP.requested, '']]);

  callList[0].resolve({ text: '앞 세션 요약' });
  await flush();
  assert.deepEqual(statusOf({ store }), [['1@0', SEGMENT_STATUS_MAP.requested, '']], '앞 세션 응답이 새 세션 칸에 붙지 않는다');

  // 앞 요청이 끝나면 새 세션의 줄을 잇는다.
  assert.equal(callList.length, 2);
  callList[1].resolve({ text: '새 세션 요약' });
  await flush();
  assert.deepEqual(statusOf({ store }), [['1@0', SEGMENT_STATUS_MAP.ready, '새 세션 요약']]);
});

test('scheduler: stop 뒤 도착한 응답도 버린다', async () => {
  const store = startStore({ markList: [[1, 0], [2, 60000], [3, 120000]] });
  const { callList, agent } = createHeldAgent();
  const scheduler = createSegmentSummaryScheduler({
    contextStore: store, segmentSummaryAgent: agent, getCaptionLanguage: () => 'ko', now: () => 130000,
  });
  scheduler.poll();
  assert.deepEqual(statusOf({ store }).map(([key]) => key), ['1@0', '2@60000']);

  scheduler.stop();
  callList[0].resolve({ text: '늦은 요약' });
  await flush();
  assert.deepEqual(statusOf({ store }), [
    ['1@0', SEGMENT_STATUS_MAP.requested, ''],
    ['2@60000', SEGMENT_STATUS_MAP.requested, ''],
  ]);
  assert.equal(callList.length, 1, '줄에 남은 구간도 보내지 않는다');

  applyMarkList({ store, markList: [[4, 125000]] });
  scheduler.poll();
  await flush();
  assert.equal(callList.length, 1, 'stop 뒤 poll 은 다음 reset 까지 무시한다');
  assert.equal(store.getSegmentSummaryList().length, 2);

  scheduler.reset();
  scheduler.poll();
  assert.equal(callList.length, 2);
});

test('scheduler: 실패한 구간은 failed 로 남기고 다음 구간으로 간다', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const store = startStore({ markList: [[1, 0], [2, 60000], [3, 120000]] });
  const { callList, agent } = createHeldAgent();
  const scheduler = createSegmentSummaryScheduler({
    contextStore: store, segmentSummaryAgent: agent, getCaptionLanguage: () => 'ko', now: () => 130000,
  });
  scheduler.poll();
  callList[0].reject(new Error('VLM 시간 초과'));
  await flush();
  assert.equal(callList.length, 2);
  callList[1].resolve({ text: '둘째 화면 요약' });
  await flush();
  assert.deepEqual(statusOf({ store }), [
    ['1@0', SEGMENT_STATUS_MAP.failed, ''],
    ['2@60000', SEGMENT_STATUS_MAP.ready, '둘째 화면 요약'],
  ]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /1@0.*VLM 시간 초과/);

  scheduler.poll();
  assert.equal(callList.length, 2, '실패한 구간은 회의 중에 다시 요청하지 않는다');
});

test('scheduler: 재료가 없는 구간은 GPU 에 묻지 않고 빈 구간 ready 로 둔 뒤 다음 구간을 보낸다', async () => {
  const store = startStore();
  applyMarkList({ store, markList: [[1, 0]] });
  applyMarkList({ store, markList: [[2, 60000]], hasSpeech: false });
  applyMarkList({ store, markList: [[3, 120000], [4, 180000]] });
  const { callList, agent } = createHeldAgent();
  const scheduler = createSegmentSummaryScheduler({
    contextStore: store, segmentSummaryAgent: agent, getCaptionLanguage: () => 'ko', now: () => 190000,
  });
  scheduler.poll();
  assert.equal(callList.length, 1);
  callList[0].resolve({ text: '첫 화면 요약' });
  await flush();
  assert.equal(callList.length, 2, '재료 없는 2@60000 을 건너뛰고 3@120000 을 보낸다');
  assert.match(callList[1].materialText, /^구간: \[02:00~03:00\]$/m);
  assert.deepEqual(statusOf({ store }), [
    ['1@0', SEGMENT_STATUS_MAP.ready, '첫 화면 요약'],
    ['2@60000', SEGMENT_STATUS_MAP.ready, ''],
    ['3@120000', SEGMENT_STATUS_MAP.requested, ''],
  ]);
});

// 처리되지 않은 거부를 모은다. 시험이 끝나면 듣기를 멈춘다.
function collectUnhandledRejection() {
  const reasonList = [];
  const listener = (reason) => reasonList.push(reason);
  process.on('unhandledRejection', listener);
  return { reasonList, stop: () => process.off('unhandledRejection', listener) };
}

test('scheduler: 에이전트가 Error 가 아닌 값으로 거부해도 failed 로 남기고 다음 구간으로 간다', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const rejection = collectUnhandledRejection();
  const store = startStore({ markList: [[1, 0], [2, 60000], [3, 120000]] });
  const { callList, agent } = createHeldAgent();
  const scheduler = createSegmentSummaryScheduler({
    contextStore: store, segmentSummaryAgent: agent, getCaptionLanguage: () => 'ko', now: () => 130000,
  });
  scheduler.poll();
  callList[0].reject(null);
  await flush();
  await flush();
  rejection.stop();
  assert.deepEqual(rejection.reasonList, []);
  assert.equal(callList.length, 2);
  assert.deepEqual(statusOf({ store })[0], ['1@0', SEGMENT_STATUS_MAP.failed, '']);
  assert.match(warn.mock.calls[0].arguments[0], /1@0/);
});

test('scheduler: 결과를 Store 에 넣다 오류가 나도 거부가 새지 않고 다음 구간으로 간다', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const rejection = collectUnhandledRejection();
  const store = startStore({ markList: [[1, 0], [2, 60000], [3, 120000]] });
  const brokenStore = { ...store, setSegmentSummary: () => { throw new Error('저장소 오류'); } };
  const { callList, agent } = createHeldAgent();
  const scheduler = createSegmentSummaryScheduler({
    contextStore: brokenStore, segmentSummaryAgent: agent, getCaptionLanguage: () => 'ko', now: () => 130000,
  });
  scheduler.poll();
  callList[0].resolve({ text: '첫 화면 요약' });
  await flush();
  await flush();
  rejection.stop();
  assert.deepEqual(rejection.reasonList, []);
  assert.equal(callList.length, 2, '줄의 다음 구간을 잇는다');
  assert.ok(warn.mock.calls.some((call) => /\[summary\].*저장소 오류/.test(call.arguments[0])),
    warn.mock.calls.map((call) => call.arguments[0]).join('\n'));
});

test('scheduler: isEnabled 가 거짓이면 요청하지 않는다', async () => {
  const store = startStore({ markList: [[1, 0], [2, 60000], [3, 120000]] });
  const { callList, agent } = createHeldAgent();
  let isEnabled = false;
  const scheduler = createSegmentSummaryScheduler({
    contextStore: store, segmentSummaryAgent: agent, getCaptionLanguage: () => 'ko',
    isEnabled: () => isEnabled, now: () => 130000,
  });
  scheduler.poll();
  assert.equal(callList.length, 0);
  assert.deepEqual(store.getSegmentSummaryList(), []);

  isEnabled = true;
  scheduler.poll();
  assert.equal(callList.length, 1);
  // 회의 중에 끄면 돌고 있는 요청만 마치고 줄의 다음 구간은 보내지 않는다.
  isEnabled = false;
  callList[0].resolve({ text: '첫 화면 요약' });
  await flush();
  assert.equal(callList.length, 1);
  isEnabled = true;
  scheduler.poll();
  assert.equal(callList.length, 2);
});

test('scheduler: 구간 길이 상한은 segment-plan 의 값을 쓴다', () => {
  const source = readSource('src/main/caption-pipeline/context/segment-summary-scheduler.js');
  assert.match(source, /\{ listSegments, DEFAULT_MAX_SEGMENT_MS \} = require\('\.\/segment-plan'\)/);
  assert.doesNotMatch(source, /300000|300_000/, '상수를 따로 두지 않는다');
});

test('config: SEEON_SUMMARY_LIVE_SEGMENTS 기본 on, off 를 받고 모르는 값은 경고하고 on', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(readPipelineConfig({}).isLiveSegmentSummaryEnabled, true);
  assert.equal(readPipelineConfig({ SEEON_SUMMARY_LIVE_SEGMENTS: '' }).isLiveSegmentSummaryEnabled, true);
  assert.equal(readPipelineConfig({ SEEON_SUMMARY_LIVE_SEGMENTS: 'on' }).isLiveSegmentSummaryEnabled, true);
  assert.equal(readPipelineConfig({ SEEON_SUMMARY_LIVE_SEGMENTS: 'off' }).isLiveSegmentSummaryEnabled, false);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(readPipelineConfig({ SEEON_SUMMARY_LIVE_SEGMENTS: 'false' }).isLiveSegmentSummaryEnabled, true);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /SEEON_SUMMARY_LIVE_SEGMENTS="false"/);
});

test('파이프라인: 세션 시작에 reset, 슬라이드 마크 반영 때와 15초마다 poll, 종료 때 스냅숏 전에 stop', () => {
  const source = readSource('src/main/caption-pipeline/index.js');
  assert.match(source, /isEnabled: \(\) => config\.isLiveSegmentSummaryEnabled && isSessionMeetingSummaryEnabled/);
  const appendBody = source.slice(source.indexOf('function appendRecord(record) {'), source.indexOf('function labelReadySlides() {'));
  assert.match(appendBody,
    /if \(record\.kind === RECORD_KIND_MAP\.slideMark && record\.frameKind === SLIDE_FRAME_KIND_BASE\) pollSegmentSummary\(\);/,
    '주석 판 마크에는 poll 하지 않는다');
  assert.equal(appendBody.match(/pollSegmentSummary\(\)/g).length, 1, '다른 기록에는 poll 하지 않는다');
  assert.doesNotMatch(appendBody, /segmentSummaryScheduler\.poll\(\)/, 'poll 실패를 [context] 기록 반영 실패로 남기지 않는다');
  const pollBody = source.slice(source.indexOf('function pollSegmentSummary() {'), source.indexOf('function stopSegmentSummaryTimer() {'));
  assert.match(pollBody, /try \{\s*segmentSummaryScheduler\.poll\(\);\s*\} catch \(error\) \{\s*console\.warn\(`\[summary\]/);
  const timerBody = source.slice(source.indexOf('function startSegmentSummaryTimer() {'), source.indexOf('function appendRecord(record) {'));
  assert.match(timerBody, /setInterval\(pollSegmentSummary, SEGMENT_SUMMARY_POLL_MS\)/);
  assert.match(source, /const SEGMENT_SUMMARY_POLL_MS = 15000;/);

  const startBody = source.slice(source.indexOf("ipcMain.handle('pipeline-session-start'"), source.indexOf("ipcMain.handle('pipeline-session-end'"));
  assert.match(startBody, /slideTextBackend, isMeetingSummaryEnabled,\s*\} = \{\}\) => \{/);
  assert.match(startBody, /contextGeneration \+= 1;\s*segmentSummaryScheduler\.reset\(\);\s*isSessionMeetingSummaryEnabled = isMeetingSummaryEnabled !== false;\s*contextStore\.start\(/);
  assert.match(startBody, /startSegmentSummaryTimer\(\);/);

  const endBody = source.slice(source.indexOf("ipcMain.handle('pipeline-session-end'"), source.indexOf("ipcMain.on('pipeline-slide-mark'"));
  const stopIndex = endBody.indexOf('segmentSummaryScheduler.stop();');
  assert.ok(stopIndex > 0 && endBody.indexOf('stopSegmentSummaryTimer();') > 0);
  assert.ok(stopIndex < endBody.indexOf('lastContextSnapshot = contextStore.snapshot();'), '스냅숏을 뜨기 전에 멈춘다');

  assert.match(source, /ipcMain\.handle\('pipeline-set-meeting-summary-enabled', async \(_event, \{ isEnabled \} = \{\}\) => \{\s*isSessionMeetingSummaryEnabled = isEnabled !== false;/);
});

test('렌더러: 세션 시작에 회의 요약 스위치 값을 넘기고, 스위치를 바꾸면 preload 로 main 에 알린다', async () => {
  const source = readSource('src/renderer/app/main.js');
  assert.match(source, /isMeetingSummaryEnabled: featureToggleStore\.isOn\(FEATURE_KEY_MAP\.meetingSummary\)/);
  assert.match(source, /if \(key === FEATURE_KEY_MAP\.meetingSummary\) syncMeetingSummaryToMain\(\{ isOn \}\);/);
  assert.match(source, /window\.seeon\.setMeetingSummaryEnabled\(\{ isEnabled: isOn \}\)/, 'preload 관례대로 객체 인자');

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
  await exposedMap.seeon.setMeetingSummaryEnabled({ isEnabled: false });
  await exposedMap.seeon.startPipelineSession({ mode: 'delayed', captionLanguage: 'ko', isMeetingSummaryEnabled: true });
  assert.deepEqual(invokeList, [
    { channel: 'pipeline-set-meeting-summary-enabled', payload: { isEnabled: false } },
    {
      channel: 'pipeline-session-start',
      payload: { mode: 'delayed', asrLanguage: undefined, captionLanguage: 'ko', slideTextBackend: undefined, isMeetingSummaryEnabled: true },
    },
  ]);
});
