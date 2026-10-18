import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pickRunSelection } from '../src/renderer/lab/control-sync.js';
import {
  createCaptionLanguageStore, CAPTION_LANGUAGE_LIST, CAPTION_LANGUAGE_STORAGE_KEY, CAPTION_LANGUAGE_LABEL_MAP,
} from '../src/renderer/core/mode/caption-language-store.js';

const require = createRequire(import.meta.url);
const languagePreset = require('../src/main/lab/meeting-language-preset.js');
const { readAutorunOption } = require('../src/main/lab/autorun-option.js');
const { ASR_LANGUAGE_LIST, DEFAULT_ASR_LANGUAGE } = require('../src/main/caption-pipeline/config.js');
const { summarizeAsrLanguage, attachDetectedLanguage } = require('../src/main/lab/export/asr-language.js');
const { buildTranscriptUtteranceList, toAsrEventListFromRecordList } = require('../src/main/lab/export/transcript.js');
const { finalizeRun, RESULT_FILE_MAP, INCOMPLETE_CODE_LIST, FINALIZE_ERROR_MAP } = require('../src/main/lab/export/finalize-run.js');
const { createRunRecorder } = require('../src/main/lab/run-recorder.js');

function createMemoryStorage(initialMap = {}) {
  const map = new Map(Object.entries(initialMap));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), map };
}

test('실험실 받아쓰기 언어는 한국어·English·자동(한·영) 중에서 고르고, 제품 기본(자동)과 달리 기본이 한국어다', () => {
  assert.deepEqual(languagePreset.LAB_ASR_LANGUAGE_LIST, ['ko', 'en', 'auto']);
  assert.deepEqual(languagePreset.LAB_ASR_LANGUAGE_LIST, ASR_LANGUAGE_LIST, 'main 이 받는 ASR 언어와 같은 값이다');
  assert.equal(languagePreset.DEFAULT_LAB_ASR_LANGUAGE, 'ko');
  assert.notEqual(languagePreset.DEFAULT_LAB_ASR_LANGUAGE, DEFAULT_ASR_LANGUAGE, '제품 기본을 따라가지 않는다');
  assert.deepEqual(languagePreset.LAB_ASR_LANGUAGE_LABEL_MAP, { ko: '한국어', en: 'English', auto: '자동(한·영)' });
  for (const language of ['ko', 'en', 'auto']) assert.equal(languagePreset.isLabAsrLanguage(language), true, language);
  assert.equal(languagePreset.isLabAsrLanguage('ja'), false);
});

test('실험실 캡션 언어는 viewer 캡션 언어와 같은 값·저장 키·이름이고 기본은 한국어다', () => {
  assert.deepEqual(languagePreset.LAB_CAPTION_LANGUAGE_LIST, ['ko', 'en']);
  assert.deepEqual(languagePreset.LAB_CAPTION_LANGUAGE_LIST, CAPTION_LANGUAGE_LIST);
  assert.equal(languagePreset.DEFAULT_LAB_CAPTION_LANGUAGE, 'ko');
  assert.equal(languagePreset.CAPTION_LANGUAGE_STORAGE_KEY, CAPTION_LANGUAGE_STORAGE_KEY);
  assert.deepEqual(languagePreset.LAB_CAPTION_LANGUAGE_LABEL_MAP, CAPTION_LANGUAGE_LABEL_MAP);
  assert.equal(languagePreset.isLabCaptionLanguage('auto'), false, '캡션 언어에는 자동이 없다');
});

test('viewer 저장소에 캡션 언어를 써 두면 viewer 가 만들 때 읽는 캡션 언어가 그 값이다', () => {
  const storage = createMemoryStorage({ [CAPTION_LANGUAGE_STORAGE_KEY]: 'ko' });
  assert.equal(languagePreset.applyCaptionLanguagePreset({ storage, language: 'en' }), true);
  assert.equal(createCaptionLanguageStore({ storage }).get(), 'en');
  assert.equal(languagePreset.applyCaptionLanguagePreset({ storage, language: 'ko' }), true);
  assert.equal(createCaptionLanguageStore({ storage }).get(), 'ko');
  // 고를 수 없는 값·저장소 없음은 쓰지 않고 지난 값을 그대로 둔다.
  assert.equal(languagePreset.applyCaptionLanguagePreset({ storage, language: 'auto' }), false);
  assert.equal(languagePreset.applyCaptionLanguagePreset({ storage, language: null }), false);
  assert.equal(languagePreset.applyCaptionLanguagePreset({ storage: null, language: 'en' }), false);
  assert.equal(storage.map.get(CAPTION_LANGUAGE_STORAGE_KEY), 'ko');
});

test('자동 실행 받아쓰기 언어는 SEEON_LAB_ASR_LANGUAGE 이고 없으면 ko, 고를 수 없는 값이면 알리고 ko 다', () => {
  const warnList = [];
  const onWarn = (message) => warnList.push(message);
  assert.equal(readAutorunOption({ SEEON_LAB_AUTORUN: '/v.mp4' }, { onWarn }).asrLanguage, 'ko');
  assert.equal(readAutorunOption({ SEEON_LAB_AUTORUN: '/v.mp4', SEEON_LAB_ASR_LANGUAGE: '' }, { onWarn }).asrLanguage, 'ko');
  assert.equal(readAutorunOption({ SEEON_LAB_AUTORUN: '/v.mp4', SEEON_LAB_ASR_LANGUAGE: 'en' }, { onWarn }).asrLanguage, 'en');
  assert.equal(readAutorunOption({ SEEON_LAB_AUTORUN: '/v.mp4', SEEON_LAB_ASR_LANGUAGE: 'auto' }, { onWarn }).asrLanguage, 'auto');
  assert.deepEqual(warnList, []);
  assert.equal(readAutorunOption({ SEEON_LAB_AUTORUN: '/v.mp4', SEEON_LAB_ASR_LANGUAGE: 'EN' }, { onWarn }).asrLanguage, 'ko');
  assert.equal(warnList.length, 1);
  assert.match(warnList[0], /SEEON_LAB_ASR_LANGUAGE="EN".*ko.*ko·en·auto/);
});

test('자동 실행 캡션 언어는 SEEON_LAB_CAPTION_LANGUAGE 이고 없으면 ko, 고를 수 없는 값이면 알리고 ko 다', () => {
  const warnList = [];
  const onWarn = (message) => warnList.push(message);
  assert.equal(readAutorunOption({ SEEON_LAB_AUTORUN: '/v.mp4' }, { onWarn }).captionLanguage, 'ko');
  assert.equal(readAutorunOption({ SEEON_LAB_AUTORUN: '/v.mp4', SEEON_LAB_CAPTION_LANGUAGE: ' ' }, { onWarn }).captionLanguage, 'ko');
  assert.equal(readAutorunOption({ SEEON_LAB_AUTORUN: '/v.mp4', SEEON_LAB_CAPTION_LANGUAGE: 'en' }, { onWarn }).captionLanguage, 'en');
  assert.deepEqual(warnList, []);
  // 받아쓰기 언어와 따로 읽는다.
  const option = readAutorunOption({ SEEON_LAB_AUTORUN: '/v.mp4', SEEON_LAB_ASR_LANGUAGE: 'auto', SEEON_LAB_CAPTION_LANGUAGE: 'en' }, { onWarn });
  assert.deepEqual([option.asrLanguage, option.captionLanguage], ['auto', 'en']);
  assert.equal(readAutorunOption({ SEEON_LAB_AUTORUN: '/v.mp4', SEEON_LAB_CAPTION_LANGUAGE: 'auto' }, { onWarn }).captionLanguage, 'ko');
  assert.equal(warnList.length, 1);
  assert.match(warnList[0], /SEEON_LAB_CAPTION_LANGUAGE="auto".*캡션 언어.*ko.*ko·en/);
});

// 가짜 electron 으로 실험 viewer preload 를 불러온다. production viewer preload 의 세션 시작은 invoke 로 보낸 값을 남긴다.
function loadLabViewerPreload({ storageMap, sendSyncMap }) {
  const exposedMap = {};
  const invokeList = [];
  const sendSyncList = [];
  const contextBridge = { exposeInMainWorld: (key, api) => { exposedMap[key] = api; } };
  const ipcRenderer = {
    send: () => {},
    on: () => {},
    invoke: async (channel, payload) => { invokeList.push([channel, payload]); return { isOk: true }; },
    sendSync: (channel) => {
      sendSyncList.push(channel);
      return sendSyncMap[channel] ?? null;
    },
  };
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { contextBridge, ipcRenderer } };
  globalThis.window = { localStorage: { setItem: (key, value) => storageMap.set(key, value), getItem: (key) => storageMap.get(key) ?? null } };
  const viewerPath = require.resolve('../src/preload/viewer.js');
  const labViewerPath = require.resolve('../src/preload/lab-viewer.js');
  delete require.cache[viewerPath];
  delete require.cache[labViewerPath];
  try {
    require('../src/preload/lab-viewer.js');
  } finally {
    delete require.cache[viewerPath];
    delete require.cache[labViewerPath];
    delete globalThis.window;
  }
  return { exposedMap, invokeList, sendSyncList, sendSyncMap };
}

test('실험 viewer preload 는 페이지 스크립트보다 먼저 이번 실행의 캡션 언어를 viewer 캡션 언어 저장 키에 써 넣는다', () => {
  const storageMap = new Map([[CAPTION_LANGUAGE_STORAGE_KEY, 'ko']]);
  const { sendSyncList } = loadLabViewerPreload({
    storageMap, sendSyncMap: { 'lab-viewer-preset': { page_transition: false }, 'lab-viewer-caption-language': 'en' },
  });
  assert.equal(storageMap.get(CAPTION_LANGUAGE_STORAGE_KEY), 'en');
  assert.equal(createCaptionLanguageStore({ storage: createMemoryStorage(Object.fromEntries(storageMap)) }).get(), 'en');
  // 제품이 더 읽지 않는 옛 회의 언어 키는 쓰지 않는다.
  assert.equal(storageMap.has('seeon.meetingLanguage'), false);
  assert.deepEqual(sendSyncList, ['lab-viewer-preset', 'lab-viewer-caption-language'], '받아쓰기 언어는 불러올 때가 아니라 세션 시작 때 받는다');
});

test('실험 viewer preload 는 제품 세션 시작 요청에 이번 실행의 받아쓰기 언어를 덧붙이고 나머지 값은 그대로 보낸다', async () => {
  const fake = loadLabViewerPreload({
    storageMap: new Map(), sendSyncMap: { 'lab-viewer-preset': {}, 'lab-viewer-caption-language': 'ko', 'lab-viewer-meeting-language': 'en' },
  });
  const result = await fake.exposedMap.seeon.startPipelineSession({ mode: 'delayed', captionLanguage: 'ko', slideTextBackend: 'vlm' });
  assert.deepEqual(result, { isOk: true });
  assert.deepEqual(fake.invokeList, [
    ['pipeline-session-start', { mode: 'delayed', asrLanguage: 'en', captionLanguage: 'ko', slideTextBackend: 'vlm' }],
  ]);
  // 세션을 시작할 때마다 그때의 값을 받는다.
  fake.sendSyncMap['lab-viewer-meeting-language'] = 'auto';
  await fake.exposedMap.seeon.startPipelineSession({ mode: 'listening', captionLanguage: 'en' });
  assert.equal(fake.invokeList[1][1].asrLanguage, 'auto');
  assert.equal(fake.invokeList[1][1].captionLanguage, 'en');
  assert.equal(fake.sendSyncList.filter((channel) => channel === 'lab-viewer-meeting-language').length, 2);
});

test('조작 바는 받아쓰기 언어를 한국어·English·자동(한·영) 중에서 고르고(기본 한국어) 실행 중에는 막으며 시작할 때 넘긴다', () => {
  const html = fs.readFileSync(new URL('../src/renderer/lab/control.html', import.meta.url), 'utf8');
  const select = html.match(/<select id="languageSelect"([^>]*)>([\s\S]*?)<\/select>/);
  assert.ok(select, 'languageSelect 가 있다');
  assert.match(select[1], /aria-label="받아쓰기 언어"/);
  const optionList = [...select[2].matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)]
    .map(([, value, selected, label]) => ({ value, label, isSelected: Boolean(selected) }));
  assert.deepEqual(optionList.map((option) => option.value), languagePreset.LAB_ASR_LANGUAGE_LIST);
  assert.deepEqual(optionList.map((option) => option.label), languagePreset.LAB_ASR_LANGUAGE_LIST.map((language) => languagePreset.LAB_ASR_LANGUAGE_LABEL_MAP[language]));
  assert.deepEqual(optionList.filter((option) => option.isSelected).map((option) => option.value), ['ko']);
  const script = fs.readFileSync(new URL('../src/renderer/lab/control.js', import.meta.url), 'utf8');
  assert.match(script, /\$\('languageSelect'\)\.disabled = !isIdle;/);
  assert.match(script, /asrLanguage: \$\('languageSelect'\)\.value/);
});

test('조작 바는 캡션 언어를 한국어·English 중에서 고르고(기본 한국어) 실행 중에는 막으며 시작할 때 넘긴다', () => {
  const html = fs.readFileSync(new URL('../src/renderer/lab/control.html', import.meta.url), 'utf8');
  const select = html.match(/<select id="captionLanguageSelect"([^>]*)>([\s\S]*?)<\/select>/);
  assert.ok(select, 'captionLanguageSelect 가 있다');
  assert.match(select[1], /aria-label="캡션 언어"/);
  assert.match(select[1], /title="[^"]*캡션 언어[^"]*"/);
  const optionList = [...select[2].matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)]
    .map(([, value, selected, label]) => ({ value, label, isSelected: Boolean(selected) }));
  assert.deepEqual(optionList.map((option) => option.value), languagePreset.LAB_CAPTION_LANGUAGE_LIST);
  assert.deepEqual(optionList.map((option) => option.label), languagePreset.LAB_CAPTION_LANGUAGE_LIST.map((language) => CAPTION_LANGUAGE_LABEL_MAP[language]));
  assert.deepEqual(optionList.filter((option) => option.isSelected).map((option) => option.value), ['ko']);
  // 받아쓰기 언어 select 바로 뒤에 둔다.
  assert.ok(html.indexOf('id="languageSelect"') < html.indexOf('id="captionLanguageSelect"'));
  const script = fs.readFileSync(new URL('../src/renderer/lab/control.js', import.meta.url), 'utf8');
  assert.match(script, /\$\('captionLanguageSelect'\)\.disabled = !isIdle;/);
  assert.match(script, /captionLanguage: \$\('captionLanguageSelect'\)\.value/);
  assert.match(script, /if \(selection\.captionLanguage\) \$\('captionLanguageSelect'\)\.value = selection\.captionLanguage;/);
});

test('실행 중에는 조작 바 select 가 상태 알림의 실행 모드·두 언어를 보이고, 쉬는 중에는 사용자가 고른 값을 건드리지 않는다', () => {
  for (const phase of ['preparing', 'running', 'paused', 'draining', 'finalizing']) {
    assert.deepEqual(pickRunSelection({ status: { phase, mode: 'listening', asrLanguage: 'en' } }), { mode: 'listening', asrLanguage: 'en' }, phase);
    assert.deepEqual(
      pickRunSelection({ status: { phase, mode: 'listening', asrLanguage: 'auto', captionLanguage: 'en' } }),
      { mode: 'listening', asrLanguage: 'auto', captionLanguage: 'en' }, phase,
    );
  }
  for (const phase of ['idle', 'done', 'failed']) {
    assert.deepEqual(pickRunSelection({ status: { phase, mode: 'listening', asrLanguage: 'en', captionLanguage: 'en' } }), {}, phase);
  }
  // 값이 없으면(옛 상태·준비 전 실패) 그 select 는 그대로 둔다.
  assert.deepEqual(pickRunSelection({ status: { phase: 'running', mode: null, captionLanguage: null } }), {});
  const script = fs.readFileSync(new URL('../src/renderer/lab/control.js', import.meta.url), 'utf8');
  assert.match(script, /pickRunSelection\(\{ status \}\)/);
});

test('실험 main 은 viewer preload 에 이번 실행의 두 언어를 주고, 세션 시작 요청의 두 언어를 실행 기록에 넘긴다', () => {
  const ipcSource = fs.readFileSync(new URL('../src/main/lab/lab-ipc.js', import.meta.url), 'utf8');
  assert.match(ipcSource, /ipcMain\.on\('lab-viewer-meeting-language', \(event\) => \{ event\.returnValue = presetState\.asrLanguage; \}\)/);
  assert.match(ipcSource, /ipcMain\.on\('lab-viewer-caption-language', \(event\) => \{ event\.returnValue = presetState\.captionLanguage; \}\)/);
  assert.match(ipcSource, /presetState\.captionLanguage = captionLanguage;/);
  assert.match(ipcSource, /captionLanguage: DEFAULT_LAB_CAPTION_LANGUAGE/);
  const indexSource = fs.readFileSync(new URL('../src/main/lab/index.js', import.meta.url), 'utf8');
  assert.match(indexSource, /'pipeline-session-start': \(\{ argList, result \}\) => sessionListener\.onStart\(result, argList\[0\]\)/);
  assert.match(indexSource, /캡션 언어 \$\{autorun\.captionLanguage\}/);
});

test('실제로 실린 회의 언어: 세션 시작 언어·ASR 요청 언어·서버가 고른 언어를 세고 고른 언어와 맞는지 본다', () => {
  const asrRecordList = [
    { kind: 'asr', ts: 1, text: 'one', language: 'auto', detectedLanguage: 'en' },
    { kind: 'asr', ts: 2, text: 'two', language: 'auto', detectedLanguage: 'en' },
    { kind: 'asr', ts: 3, text: '셋', language: 'auto', detectedLanguage: 'ko' },
    { kind: 'asr', ts: 4, text: '', language: 'auto', detectedLanguage: null },
  ];
  assert.deepEqual(summarizeAsrLanguage({ requestedLanguage: 'auto', sessionLanguage: 'auto', asrRecordList }), {
    sessionLanguage: 'auto',
    requestLanguageCountMap: { auto: 4 },
    detectedLanguageCountMap: { en: 2, ko: 1 },
    isMatched: true,
  });
  // viewer 가 지난 값으로 세션을 열었으면 맞지 않는다.
  assert.equal(summarizeAsrLanguage({
    requestedLanguage: 'en', sessionLanguage: 'ko', asrRecordList: [{ kind: 'asr', ts: 1, language: 'ko', detectedLanguage: 'ko' }],
  }).isMatched, false);
  // 세션 시작을 못 봤어도 ASR 요청 언어로 판단한다.
  assert.equal(summarizeAsrLanguage({
    requestedLanguage: 'en', sessionLanguage: null, asrRecordList: [{ kind: 'asr', ts: 1, language: 'en', detectedLanguage: 'en' }],
  }).isMatched, true);
  // 근거가 하나도 없으면 모른다.
  assert.deepEqual(summarizeAsrLanguage({ requestedLanguage: 'en', sessionLanguage: null, asrRecordList: [{ kind: 'asr', ts: 1, text: '옛 기록' }] }), {
    sessionLanguage: null, requestLanguageCountMap: {}, detectedLanguageCountMap: {}, isMatched: null,
  });
});

test('전사 발화에는 서버가 고른 언어(detectedLanguage)가 있을 때만 붙는다', () => {
  const asrRecordList = [
    { kind: 'asr', ts: 3000, text: 'hello there', language: 'auto', detectedLanguage: 'en' },
    { kind: 'asr', ts: 9000, text: '안녕', language: 'auto', detectedLanguage: null },
  ];
  const asrEventList = attachDetectedLanguage({
    asrEventList: [
      { ts: 3000, endTs: 5000, text: 'hello there', segmentList: [{ startSec: 0, endSec: 1, text: 'hello' }, { startSec: 1, endSec: 2, text: 'there' }] },
      { ts: 9000, endTs: 10000, text: '안녕', segmentList: [] },
      { ts: 12000, endTs: 13000, text: '기록 없음', segmentList: [] },
    ],
    asrRecordList,
  });
  const utteranceList = buildTranscriptUtteranceList({ asrEventList, toMediaMs: (wallMs) => wallMs - 1000 });
  assert.deepEqual(utteranceList, [
    { startMs: 2000, endMs: 3000, text: 'hello', detectedLanguage: 'en' },
    { startMs: 3000, endMs: 4000, text: 'there', detectedLanguage: 'en' },
    { startMs: 8000, endMs: 9000, text: '안녕' },
    { startMs: 11000, endMs: 12000, text: '기록 없음' },
  ]);
  assert.deepEqual(toAsrEventListFromRecordList(asrRecordList), [
    { ts: 3000, endTs: null, text: 'hello there', segmentList: [], detectedLanguage: 'en' },
    { ts: 9000, endTs: null, text: '안녕', segmentList: [] },
  ]);
});

function prepareRun({ asrLanguage, sessionAsrLanguage, recordLanguage, captionLanguage = 'ko', sessionCaptionLanguage = 'ko' }) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-language-'));
  const runDir = path.join(rootDir, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, RESULT_FILE_MAP.outputAudio), 'webm');
  const recordPath = path.join(rootDir, 'pipeline-1.jsonl');
  fs.writeFileSync(recordPath, [
    JSON.stringify({ kind: 'asr', ts: 3000, text: 'revenue grew', language: recordLanguage, detectedLanguage: 'en', sessionId: 'session-1' }),
    JSON.stringify({ kind: 'asr', ts: 7000, text: 'look here', language: recordLanguage, detectedLanguage: 'en', sessionId: 'session-1' }),
  ].join('\n'));
  const recorder = createRunRecorder({ now: () => 1000 });
  recorder.start({
    runId: 'run-1', runDir, videoPath: '/v/english.mp4', mode: 'delayed', isEvalPreset: true, featureToggleMap: {}, asrLanguage, captionLanguage,
  });
  recorder.markSessionStart({ sessionId: 'session-1', recordPath, asrLanguage: sessionAsrLanguage, captionLanguage: sessionCaptionLanguage });
  recorder.addViewerEvent({ type: 'asr', ts: 3000, endTs: 5000, text: 'revenue grew', segmentList: [] });
  recorder.addViewerEvent({ type: 'asr', ts: 7000, endTs: 9000, text: 'look here', segmentList: [] });
  recorder.addPlayerTime({ wallMs: 1000, mediaMs: 0, paused: false, ended: false });
  recorder.addPlayerTime({ wallMs: 61000, mediaMs: 60000, paused: false, ended: true });
  recorder.markEnded();
  return { runDir, run: recorder.snapshot() };
}

test('결과 폴더 run.json 에 고른 두 언어와 실제로 실린 언어가, transcript.json 에 발화마다 서버가 고른 언어가 남는다', async () => {
  const { runDir, run } = prepareRun({
    asrLanguage: 'en', sessionAsrLanguage: 'en', recordLanguage: 'en', captionLanguage: 'en', sessionCaptionLanguage: 'en',
  });
  const result = await finalizeRun({ run, modelConfig: {} });
  const runInfo = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  assert.equal(runInfo.asrLanguage, 'en');
  assert.equal(runInfo.captionLanguage, 'en');
  assert.equal(runInfo.sessionCaptionLanguage, 'en');
  assert.deepEqual(runInfo.asrLanguageApplied, {
    sessionLanguage: 'en', requestLanguageCountMap: { en: 2 }, detectedLanguageCountMap: { en: 2 }, isMatched: true,
  });
  assert.equal(result.isComplete, true);
  const { utteranceList } = JSON.parse(fs.readFileSync(path.join(runDir, 'transcript.json'), 'utf8'));
  assert.deepEqual(utteranceList.map((utterance) => utterance.detectedLanguage), ['en', 'en']);
  assert.equal(fs.readFileSync(path.join(runDir, 'transcript.txt'), 'utf8'), '[00:02] revenue grew\n[00:06] look here\n');
});

test('고른 회의 언어로 전사되지 않았으면 asr_language_mismatch 로 남기고 결과물이 빠진 것으로 본다', async () => {
  const { runDir, run } = prepareRun({ asrLanguage: 'en', sessionAsrLanguage: 'ko', recordLanguage: 'ko' });
  const result = await finalizeRun({ run, modelConfig: {} });
  assert.equal(FINALIZE_ERROR_MAP.asrLanguageMismatch, 'asr_language_mismatch');
  assert.ok(INCOMPLETE_CODE_LIST.includes('asr_language_mismatch'));
  assert.equal(result.isComplete, false);
  const runInfo = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const mismatch = runInfo.errorList.find((error) => error.code === 'asr_language_mismatch');
  assert.ok(mismatch);
  assert.match(mismatch.message, /en.*ko/);
  assert.equal(runInfo.asrLanguageApplied.isMatched, false);
});
