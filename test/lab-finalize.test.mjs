import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createFeatureToggleStore, FEATURE_KEY_LIST, FEATURE_TOGGLE_STORAGE_KEY } from '../src/renderer/core/mode/feature-toggle-store.js';

const require = createRequire(import.meta.url);
const { createRunRecorder } = require('../src/main/lab/run-recorder.js');
const { finalizeRun, RESULT_FILE_MAP } = require('../src/main/lab/export/finalize-run.js');
const { readSessionRecordList } = require('../src/main/lab/export/pipeline-records.js');
const { pickModelConfig } = require('../src/main/lab/export/run-info.js');
const preset = require('../src/main/lab/feature-toggle-preset.js');
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');

function createMemoryStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), map };
}

test('평가 설정은 페이지 전환·화자 안내·회의 요약을 끄고 끄면 제품 기본값(모두 켜짐)이다', () => {
  assert.equal(preset.FEATURE_TOGGLE_STORAGE_KEY, FEATURE_TOGGLE_STORAGE_KEY);
  assert.deepEqual(Object.keys(preset.buildFeatureTogglePreset({ isEvalPreset: true })).sort(), [...FEATURE_KEY_LIST].sort());
  const storage = createMemoryStorage();
  preset.applyFeatureTogglePreset({ storage, presetMap: preset.buildFeatureTogglePreset({ isEvalPreset: true }) });
  const evalStore = createFeatureToggleStore({ storage });
  assert.deepEqual(FEATURE_KEY_LIST.map((key) => evalStore.isOn(key)), [false, false, false]);
  preset.applyFeatureTogglePreset({ storage, presetMap: preset.buildFeatureTogglePreset({ isEvalPreset: false }) });
  const productStore = createFeatureToggleStore({ storage });
  assert.deepEqual(FEATURE_KEY_LIST.map((key) => productStore.isOn(key)), [true, true, true]);
});

test('실행 기록기는 실행 중에 온 이벤트만 모으고 재생 중인 해설이 끝나는 시각을 안다', () => {
  let nowMs = 1000;
  const recorder = createRunRecorder({ now: () => nowMs });
  recorder.addViewerEvent({ type: 'caption', text: '실행 전' });
  recorder.start({ runId: 'r', runDir: '/tmp/r', videoPath: '/v.mp4', mode: 'delayed', isEvalPreset: true, featureToggleMap: {} });
  recorder.addViewerEvent({ type: 'asr', ts: 1, text: '말' });
  recorder.addViewerEvent({ type: 'caption', ts: 2, text: '해설' });
  recorder.addViewerEvent({ type: 'debug' });
  recorder.addPlayback({ wallMs: 5000, durationMs: 2500 });
  recorder.addPlayback({ wallMs: 6000, durationMs: 500 });
  recorder.markCaptureRequested({ wallMs: 1200 });
  recorder.markCaptureRequested({ wallMs: 9999 });
  assert.equal(recorder.getPlayingUntilWallMs(), 7500);
  nowMs = 9000;
  recorder.markEnded();
  recorder.addViewerEvent({ type: 'caption', text: '마무리 중' });
  const run = recorder.snapshot();
  assert.deepEqual(run.captionEventList.map((event) => event.text), ['해설']);
  assert.equal(run.asrEventList.length, 1);
  assert.equal(run.captureRequestedWallMs, 1200);
  assert.equal(run.endedAtMs, 9000);
});

test('모델 설정에는 비밀값이 실리지 않는다', () => {
  const config = readPipelineConfig({ AWS_BEARER_TOKEN_BEDROCK: 'secret-token-value', SEEON_BEDROCK_MODEL_ID: 'anthropic.claude-sonnet-5' });
  const modelConfig = pickModelConfig(config);
  assert.equal(modelConfig.bedrockModelId, 'anthropic.claude-sonnet-5');
  assert.equal(modelConfig.hasBedrockCredentials, true);
  assert.doesNotMatch(JSON.stringify(modelConfig), /secret-token-value/);
  assert.deepEqual([modelConfig.judgeBackend, modelConfig.judgeGpuUrl, modelConfig.judgeGpuModel],
    ['gpu', 'http://127.0.0.1:8805/v1/chat/completions', 'qwen3.5-9b'], '판단 LLM 이 어느 GPU 서버로 갔는지 남긴다');
});

function prepareRunDir() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-finalize-'));
  const runDir = path.join(rootDir, 'run');
  const slideFile = path.join(rootDir, 'slides', 'session-1', 'slide-1', 'base.jpg');
  fs.mkdirSync(path.dirname(slideFile), { recursive: true });
  fs.writeFileSync(slideFile, 'jpg');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, RESULT_FILE_MAP.outputAudio), 'webm');
  const recordPath = path.join(rootDir, 'pipeline-1.jsonl');
  fs.writeFileSync(recordPath, [
    JSON.stringify({ kind: 'slide_mark', ts: 3000, slideLabel: '1', frameKind: 'base', filePath: slideFile, transitionTs: 2500, sessionId: 'session-1' }),
    JSON.stringify({ kind: 'deixis', ts: 50000, caption: '해설', utterance: '이 부분이요', judgeReason: null, sessionId: 'session-1' }),
    JSON.stringify({ kind: 'narration', ts: 40000, text: '중복', isEmitted: false, skipReason: 'duplicate:text', sessionId: 'session-1' }),
    JSON.stringify({ kind: 'asr', ts: 1, text: '다른 세션', sessionId: 'session-0' }),
    '{깨진 줄',
  ].join('\n'));
  return { rootDir, runDir, recordPath };
}

function buildRun({ runDir, recordPath, patch = {} }) {
  return {
    runId: 'run-1', runDir, videoPath: '/v/sample.mp4', videoInfo: { durationMs: 60000, videoWidth: 1920, videoHeight: 1080, viewport: { vw: 1152, vh: 1016, dpr: 2 } },
    mode: 'realtime_mix', isEvalPreset: true, featureToggleMap: { page_transition: false }, layout: null, git: { head: 'abc' },
    startedAtMs: 1000, endedAtMs: 70000, captureRequestedWallMs: 1000, outputStartWallMs: 1500, outputStopWallMs: 69000,
    outputMimeType: 'audio/webm', playStartWallMs: 2000, videoEndedWallMs: 62000,
    sessionId: 'session-1', recordPath, isSessionEnded: true, roiNormRect: null,
    asrEventList: [{ type: 'asr', ts: 3000, endTs: 5000, text: '이 부분이요', segmentList: [] }],
    captionEventList: [{ type: 'caption', ts: 50000, text: '해설', source: 'deixis', narrationClass: 'deixis', slideLabel: '1', eventVideoTimeMs: 4000, rationale: { utterance: '이 부분이요', summary: '근거 표현=이 부분' } }],
    playbackList: [{ ts: 50000, text: '해설', narrationClass: 'deixis', mode: 'realtime_mix', wallMs: 6000, durationMs: 2000, playbackVideoTimeMs: null, liveVideoTimeMs: 5000 }],
    playerTimeList: [{ wallMs: 1000, mediaMs: 0, paused: true, ended: false }, { wallMs: 2000, mediaMs: 0, paused: false, ended: false }, { wallMs: 62000, mediaMs: 60000, paused: false, ended: true }],
    rendererDropList: [],
    errorList: [],
    ...patch,
  };
}

test('결과 폴더 마무리는 정해진 파일을 모두 쓰고 그 세션 레코드만 남긴다', async () => {
  const { runDir, recordPath } = prepareRunDir();
  const result = await finalizeRun({ run: buildRun({ runDir, recordPath }), modelConfig: { bedrockModelId: 'm' } });
  assert.deepEqual(fs.readdirSync(runDir).sort(), [
    'ad-timeline.json', 'ad.srt', 'flow.json', 'output-audio.webm', 'pipeline.jsonl', 'run.json', 's-condition.txt', 'slides', 'slides.json', 'transcript.json', 'transcript.txt',
  ]);
  assert.deepEqual(fs.readdirSync(path.join(runDir, 'slides')), ['slide-1.jpg']);
  const runInfo = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  assert.equal(runInfo.isComplete, true);
  assert.deepEqual(runInfo.errorList.map((error) => error.code), ['record_line_broken']);
  assert.equal(runInfo.mode, 'realtime_mix');
  assert.equal(runInfo.modeLabel, '동시');
  assert.equal(runInfo.adTiming.adCount, 1);
  assert.equal(runInfo.counts.recordCount, 3);
  const { adList, droppedList } = JSON.parse(fs.readFileSync(path.join(runDir, 'ad-timeline.json'), 'utf8'));
  assert.equal(adList[0].eventMediaMs, 3000);
  assert.equal(adList[0].playedMediaMs, 4000);
  assert.equal(adList[0].outputMs, 4500);
  assert.equal(adList[0].trigger.utterance, '이 부분이요');
  assert.deepEqual(droppedList.map((drop) => drop.reason), ['duplicate:text']);
  assert.equal(fs.readFileSync(path.join(runDir, 's-condition.txt'), 'utf8'), '[00:01] 이 부분이요\n[00:04] (화면 해설) 해설\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'slides.json'), 'utf8')).slideList, [{ label: '1', startMediaMs: 500, file: 'slides/slide-1.jpg' }]);
  assert.equal(fs.readFileSync(path.join(runDir, 'pipeline.jsonl'), 'utf8').trim().split('\n').length, 3);
  assert.equal(result.isComplete, true);
});

test('세션 jsonl 을 못 찾으면 모은 것까지 쓰고 isComplete=false 로 남긴다', async () => {
  const { runDir } = prepareRunDir();
  const result = await finalizeRun({
    run: buildRun({ runDir, recordPath: path.join(runDir, '없는.jsonl'), patch: { asrEventList: [] } }),
    modelConfig: {},
  });
  assert.equal(result.isComplete, false);
  const runInfo = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  assert.deepEqual(runInfo.errorList.map((error) => error.code), ['record_read_failed']);
  assert.ok(fs.existsSync(path.join(runDir, 'transcript.txt')));
  assert.ok(fs.existsSync(path.join(runDir, 'ad-timeline.json')));
});

test('세션 정보·시각 보고·녹음이 없으면 각각 오류로 남긴다', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-finalize-empty-'));
  const runDir = path.join(rootDir, 'run');
  const result = await finalizeRun({
    run: buildRun({ runDir, recordPath: null, patch: { sessionId: null, playerTimeList: [], playbackList: [] } }),
    modelConfig: {},
  });
  assert.deepEqual(result.errorList.map((error) => error.code), ['session_unknown', 'no_player_time', 'no_playback_report', 'no_output_audio']);
  assert.equal(result.isComplete, false);
});

test('세션 jsonl 은 그 세션 레코드만 읽고 깨진 줄 수를 센다', async () => {
  const { recordPath } = prepareRunDir();
  const { recordList, brokenLineCount } = await readSessionRecordList({ recordPath, sessionId: 'session-1' });
  assert.equal(recordList.length, 3);
  assert.equal(brokenLineCount, 1);
});

test('원본 파이프라인 설정을 그대로 넘겨도 결과 폴더 어느 파일에도 비밀값이 남지 않는다', async () => {
  const { runDir, recordPath } = prepareRunDir();
  const secretList = ['secret-token-value', 'secret-access-key-value', 'url-password-value', 'url-query-token-value'];
  const config = readPipelineConfig({
    AWS_BEARER_TOKEN_BEDROCK: secretList[0],
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    AWS_SECRET_ACCESS_KEY: secretList[1],
    SEEON_VLM_URL: `http://lab:${secretList[2]}@127.0.0.1:8801/v1/chat/completions?token=${secretList[3]}`,
  });
  await finalizeRun({ run: buildRun({ runDir, recordPath }), modelConfig: config });
  const runInfo = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  assert.equal('bedrockApiKey' in runInfo.modelConfig, false);
  assert.equal(runInfo.modelConfig.hasBedrockCredentials, true);
  assert.equal(runInfo.modelConfig.vlmUrl, 'http://127.0.0.1:8801/v1/chat/completions');
  assert.equal(runInfo.modelConfig.asrUrl, 'http://127.0.0.1:8802/asr');
  for (const name of fs.readdirSync(runDir)) {
    const filePath = path.join(runDir, name);
    if (fs.statSync(filePath).isDirectory()) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const secret of secretList) assert.equal(text.includes(secret), false, `${name} 에 비밀값이 남았다`);
  }
});

test('run.json 을 못 쓰면 돌려주는 값이 isComplete=false 와 write_failed 를 알린다', async () => {
  const { runDir, recordPath } = prepareRunDir();
  const fsApi = {
    ...fs.promises,
    writeFile: (filePath, ...rest) => (path.basename(filePath) === RESULT_FILE_MAP.runInfo
      ? Promise.reject(new Error('디스크 가득 참')) : fs.promises.writeFile(filePath, ...rest)),
  };
  const result = await finalizeRun({ run: buildRun({ runDir, recordPath }), modelConfig: {}, fsApi });
  assert.equal(result.isComplete, false);
  assert.deepEqual(result.errorList.map((error) => error.code), ['record_line_broken', 'write_failed']);
  assert.equal(fs.existsSync(path.join(runDir, RESULT_FILE_MAP.runInfo)), false);
  assert.ok(fs.existsSync(path.join(runDir, RESULT_FILE_MAP.adTimeline)));
});

test('시각이 빠진 재생 알림이 와도 재생 중인 해설이 끝나는 시각은 숫자다', () => {
  const recorder = createRunRecorder({ now: () => 0 });
  recorder.start({ runId: 'r', runDir: '/tmp/r', videoPath: '/v.mp4', mode: 'delayed', isEvalPreset: true, featureToggleMap: {} });
  recorder.addPlayback({ wallMs: 4000, durationMs: 1000 });
  recorder.addPlayback({ durationMs: 3000 });
  assert.equal(recorder.getPlayingUntilWallMs(), 5000);
});

test('viewer 소리 녹음이 비었거나 없으면 결과물이 빠진 것으로 본다', async () => {
  const emptyCase = prepareRunDir();
  fs.writeFileSync(path.join(emptyCase.runDir, RESULT_FILE_MAP.outputAudio), '');
  const emptyResult = await finalizeRun({ run: buildRun(emptyCase), modelConfig: {} });
  assert.equal(emptyResult.isComplete, false);
  assert.ok(emptyResult.errorList.some((error) => error.code === 'no_output_audio'));

  const missingCase = prepareRunDir();
  fs.rmSync(path.join(missingCase.runDir, RESULT_FILE_MAP.outputAudio));
  const missingResult = await finalizeRun({ run: buildRun(missingCase), modelConfig: {} });
  assert.equal(missingResult.isComplete, false);
  const runInfo = JSON.parse(fs.readFileSync(path.join(missingCase.runDir, 'run.json'), 'utf8'));
  assert.equal(runInfo.isComplete, false);
  assert.deepEqual(runInfo.errorList.map((error) => error.code), ['record_line_broken', 'no_output_audio']);
});

test('해설은 왔는데 재생 시작 알림이 하나도 없으면 결과물이 빠진 것으로 본다', async () => {
  const { runDir, recordPath } = prepareRunDir();
  const result = await finalizeRun({ run: buildRun({ runDir, recordPath, patch: { playbackList: [] } }), modelConfig: {} });
  assert.equal(result.isComplete, false);
  assert.deepEqual(result.errorList.map((error) => error.code), ['record_line_broken', 'no_playback_report']);
});

test('해설이 하나도 없던 실행은 재생 알림이 없어도 녹음·기록이 있으면 완전하다', async () => {
  const { runDir, recordPath } = prepareRunDir();
  const result = await finalizeRun({
    run: buildRun({ runDir, recordPath, patch: { captionEventList: [], playbackList: [] } }),
    modelConfig: {},
  });
  assert.equal(result.isComplete, true);
  assert.deepEqual(result.errorList.map((error) => error.code), ['record_line_broken']);
});
