import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createRunController, RUN_PHASE_MAP, RUN_ERROR_MAP, SESSION_END_TIMEOUT_MS, VIEWER_RELOAD_TIMEOUT_MS, LIVE_WAIT_MS,
} = require('../src/main/lab/run-controller.js');
const { createRunRecorder } = require('../src/main/lab/run-recorder.js');
const { createOutputWriter } = require('../src/main/lab/output-writer.js');
const { finalizeRun, INCOMPLETE_CODE_LIST } = require('../src/main/lab/export/finalize-run.js');

function createHarness({
  isStartable = true, isLiveAfterClick = true, isSessionEnding = true, startOutputError = null,
  reloadBehavior = 'ok', stopOutputError = null, finalizeError = null, clickPauseResult = true, isSessionEndImmediate = false,
  recordPath = '/out/pipeline-1.jsonl', finalize = null, createOutputWriter: createWriter = createOutputWriter,
  getLayout = undefined, hangCallList = [], lateLiveDelayMs = null, beforeSessionStart = () => {}, onPlayback = undefined,
} = {}) {
  const clock = { nowMs: new Date(2026, 9, 5, 10, 0, 0).getTime() };
  const callList = [];
  const statusList = [];
  const finalizedList = [];
  const optionMap = { reloadBehavior, hangCallSet: new Set(hangCallList) };
  let isLive = false;
  let lateLiveAtMs = null;
  let controller = null;
  // 응답하지 않는 화면: hangCallSet 에 든 호출은 끝나지 않는다.
  const hangIfListed = async (name) => { if (optionMap.hangCallSet.has(name)) await new Promise(() => {}); };
  const goLive = () => {
    beforeSessionStart();
    controller.sessionListener.onStart({ isOk: true, sessionId: 'session-1', recordPath });
    isLive = true;
  };
  const viewerDriver = {
    reload: async () => {
      callList.push('viewer.reload');
      if (optionMap.reloadBehavior === 'hang') await new Promise(() => {});
      if (optionMap.reloadBehavior === 'reject') throw new Error('production 화면이 없다');
    },
    selectMode: async ({ mode }) => {
      callList.push(`viewer.selectMode:${mode}`);
      await hangIfListed('viewer.selectMode');
      return mode;
    },
    isStartable: async () => { await hangIfListed('viewer.isStartable'); return isStartable; },
    isLive: async () => {
      await hangIfListed('viewer.isLive');
      // 늦은 LIVE: 시작 버튼을 누른 뒤 lateLiveDelayMs 가 지나서야 캡처가 붙는다.
      if (lateLiveAtMs !== null && clock.nowMs >= lateLiveAtMs) {
        lateLiveAtMs = null;
        goLive();
      }
      return isLive;
    },
    clickToggle: async () => {
      callList.push('viewer.clickToggle');
      await hangIfListed('viewer.clickToggle');
      if (!isLive) {
        if (lateLiveDelayMs !== null) {
          controller.handleCaptureRequested({ wallMs: clock.nowMs });
          lateLiveAtMs = clock.nowMs + lateLiveDelayMs;
          return true;
        }
        if (!isLiveAfterClick) return true;
        controller.handleCaptureRequested({ wallMs: clock.nowMs });
        goLive();
      } else {
        isLive = false;
        if (isSessionEndImmediate) controller.sessionListener.onEnd({ isOk: true, sessionId: 'session-1' });
        else if (isSessionEnding) setImmediate(() => controller.sessionListener.onEnd({ isOk: true, sessionId: 'session-1' }));
      }
      return true;
    },
    clickPause: async () => { callList.push('viewer.clickPause'); return clickPauseResult; },
  };
  const playerDriver = {
    setRoiEditing: async ({ isEditing }) => {
      callList.push(`player.setRoiEditing:${isEditing}`);
      await hangIfListed('player.setRoiEditing');
      return { roiNormRect: { x: 0, y: 0, w: 1, h: 1 } };
    },
    load: async ({ fileUrl }) => {
      callList.push(`player.load:${fileUrl}`);
      await hangIfListed('player.load');
      return { durationMs: 60000, videoWidth: 1920, videoHeight: 1080 };
    },
    startOutputRecording: async () => {
      callList.push('player.startOutputRecording');
      await hangIfListed('player.startOutputRecording');
      if (startOutputError) throw new Error(startOutputError);
      return { startedWallMs: clock.nowMs, mimeType: 'audio/webm;codecs=opus' };
    },
    stopOutputRecording: async () => {
      callList.push('player.stopOutputRecording');
      await hangIfListed('player.stopOutputRecording');
      if (stopOutputError) throw new Error(stopOutputError);
      return { stoppedWallMs: clock.nowMs };
    },
    play: async () => { callList.push('player.play'); await hangIfListed('player.play'); },
    pause: async () => { callList.push('player.pause'); await hangIfListed('player.pause'); },
  };
  const labRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-controller-'));
  const presetList = [];
  const finishedResolveList = [];
  // 영상 끝 → 대기 → 마무리는 비동기로 이어진다. 마무리 알림을 기다려 시간에 기대지 않고 확인한다.
  const waitFinished = () => new Promise((resolve) => { finishedResolveList.push(resolve); });
  const fakeFinalize = async ({ run }) => {
    finalizedList.push({ run, atMs: clock.nowMs });
    if (finalizeError) throw new Error(finalizeError);
    return { isComplete: run.errorList.length === 0, errorList: run.errorList, runDir: run.runDir };
  };
  const realFinalize = finalize && (async (argMap) => {
    finalizedList.push({ run: argMap.run, atMs: clock.nowMs });
    return finalize(argMap);
  });
  controller = createRunController({
    viewerDriver,
    playerDriver,
    recorder: createRunRecorder({ now: () => clock.nowMs }),
    finalize: realFinalize || fakeFinalize,
    readGit: async () => ({ head: 'abc', productionMergeBase: 'def' }),
    createOutputWriter: createWriter,
    setViewerPreset: (preset) => presetList.push(preset),
    labRootDir,
    modelConfig: { bedrockModelId: 'm' },
    getLayout,
    notify: (status) => statusList.push(status),
    onPlayback,
    onRunFinished: (result) => { finishedResolveList.splice(0).forEach((resolve) => resolve(result)); },
    now: () => clock.nowMs,
    wait: async (ms) => { clock.nowMs += ms; await new Promise((resolve) => { setImmediate(resolve); }); },
  });
  // viewer 가 스스로 캡처를 멈춘 상황(스트림 끊김 등)을 흉내 낸다.
  const setLive = (value) => { isLive = value; };
  return { controller, clock, callList, statusList, finalizedList, presetList, labRootDir, waitFinished, optionMap, setLive };
}

// 가짜 시계의 wait 는 setImmediate 한 번으로 끝난다. 대기 반복이 몇 바퀴 돌 시간을 준다.
async function flushImmediate({ count }) {
  for (let index = 0; index < count; index += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

test('시작: 평가 설정 → viewer 새로고침 → 균형 모드 → 영상 → 녹음 → 캡처 시작 → 재생 순서다', async () => {
  const harness = createHarness();
  const result = await harness.controller.start({ videoPath: '/videos/발표 1.mp4', isEvalPreset: true });
  assert.equal(result.isOk, true);
  assert.deepEqual(harness.presetList, [{ isEvalPreset: true }]);
  assert.deepEqual(harness.callList, [
    'viewer.reload', 'viewer.selectMode:delayed', 'player.setRoiEditing:false',
    'player.load:file:///videos/%EB%B0%9C%ED%91%9C%201.mp4', 'player.startOutputRecording', 'viewer.clickToggle', 'player.play',
  ]);
  assert.equal(harness.controller.getStatus().phase, RUN_PHASE_MAP.running);
  assert.match(path.basename(result.runDir), /^20261005-100000-발표_1$/);
});

test('평가 설정을 끄면 제품 기본(동시) 모드이고 고른 모드가 있으면 그 모드다', async () => {
  const defaultHarness = createHarness();
  await defaultHarness.controller.start({ videoPath: '/v.mp4', isEvalPreset: false });
  assert.ok(defaultHarness.callList.includes('viewer.selectMode:realtime_mix'));
  const chosenHarness = createHarness();
  await chosenHarness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true, mode: 'listening' });
  assert.ok(chosenHarness.callList.includes('viewer.selectMode:listening'));
});

test('영상이 끝나면 모드 지연 + TTL + 여유만큼 기다린 뒤 녹음 정지 → viewer 정지 → 세션 종료 → 결과 폴더 순서로 마무리한다', async () => {
  const harness = createHarness();
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  const endedWallMs = harness.clock.nowMs;
  harness.callList.length = 0;
  const finished = harness.waitFinished();
  harness.controller.handlePlayerTime({ wallMs: endedWallMs, mediaMs: 60000, paused: false, ended: true });
  assert.equal(harness.controller.getStatus().phase, RUN_PHASE_MAP.draining);
  await finished;
  assert.equal(harness.finalizedList.length, 1);
  assert.ok(harness.finalizedList[0].atMs - endedWallMs >= 10000 + 8000 + 15000, '균형 모드: 지연 10초 + TTL 8초 + 여유 15초');
  assert.deepEqual(harness.callList, ['player.stopOutputRecording', 'viewer.clickToggle', 'player.pause']);
  const { run } = harness.finalizedList[0];
  assert.equal(run.sessionId, 'session-1');
  assert.equal(run.isSessionEnded, true);
  assert.equal(run.mode, 'delayed');
  assert.equal(run.featureToggleMap.page_transition, false);
  assert.ok(Number.isFinite(run.captureRequestedWallMs));
  assert.equal(harness.controller.getStatus().phase, RUN_PHASE_MAP.done);
});

test('해설이 재생 중이면 끝날 때까지 더 기다린다', async () => {
  const harness = createHarness();
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: false });
  const endedWallMs = harness.clock.nowMs;
  harness.controller.handleNarrationPlayback({ ts: 1, text: '긴 해설', wallMs: endedWallMs + 30000, durationMs: 20000 });
  const finished = harness.waitFinished();
  harness.controller.handlePlayerTime({ wallMs: endedWallMs, mediaMs: 60000, paused: false, ended: true });
  await finished;
  assert.ok(harness.finalizedList[0].atMs >= endedWallMs + 51000);
});

test('ROI 를 못 받아 시작할 수 없으면 캡처를 누르지 않고 이유를 남겨 결과 폴더를 마무리한다', async () => {
  const harness = createHarness({ isStartable: false });
  const result = await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  assert.equal(result.isOk, false);
  assert.match(result.message, /ROI/);
  assert.equal(harness.callList.includes('viewer.clickToggle'), false);
  assert.deepEqual(harness.finalizedList[0].run.errorList.map((error) => error.code), ['roi_missing']);
  assert.equal(harness.controller.getStatus().phase, RUN_PHASE_MAP.failed);
});

test('캡처가 시작되지 않으면 capture_failed 로 남긴다', async () => {
  const harness = createHarness({ isLiveAfterClick: false });
  const result = await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  assert.equal(result.isOk, false);
  assert.deepEqual(harness.finalizedList[0].run.errorList.map((error) => error.code), ['capture_failed']);
});

test('녹음을 시작하지 못해도 실행은 계속하고 오류만 남긴다', async () => {
  const harness = createHarness({ startOutputError: 'NotAllowedError' });
  const result = await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  assert.equal(result.isOk, true);
  await harness.controller.stop();
  assert.deepEqual(harness.finalizedList[0].run.errorList.map((error) => error.code), ['output_record_failed']);
});

test('일시정지는 재생 화면과 viewer 를 함께 멈추고 재개도 함께 한다', async () => {
  const harness = createHarness();
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  harness.callList.length = 0;
  assert.equal((await harness.controller.pause()).isOk, true);
  assert.equal(harness.controller.getStatus().phase, RUN_PHASE_MAP.paused);
  assert.equal((await harness.controller.resume()).isOk, true);
  assert.deepEqual(harness.callList, ['player.pause', 'viewer.clickPause', 'viewer.clickPause', 'player.play']);
});

test('정지를 누르면 기다리지 않고 바로 마무리한다', async () => {
  const harness = createHarness();
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  const stoppedAtMs = harness.clock.nowMs;
  await harness.controller.stop();
  assert.ok(harness.finalizedList[0].atMs - stoppedAtMs < 1000);
  assert.equal((await harness.controller.stop()).isOk, false, '두 번째 정지는 할 일이 없다');
});

test('파이프라인 세션이 닫히지 않으면 시간 제한 뒤 session_end_timeout 으로 남긴다', async () => {
  const harness = createHarness({ isSessionEnding: false });
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  const stoppedAtMs = harness.clock.nowMs;
  await harness.controller.stop();
  assert.ok(harness.finalizedList[0].atMs - stoppedAtMs >= SESSION_END_TIMEOUT_MS);
  assert.deepEqual(harness.finalizedList[0].run.errorList.map((error) => error.code), ['session_end_timeout']);
});

test('녹음 조각은 받은 순서대로 이어 붙이고 실행 중이 아닐 때 ROI 편집만 받는다', async () => {
  const harness = createHarness();
  assert.equal((await harness.controller.setRoiEditing({ isEditing: true })).isOk, true);
  const { runDir } = await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  assert.equal((await harness.controller.setRoiEditing({ isEditing: true })).isOk, false);
  harness.controller.handleOutputChunk({ buffer: new Uint8Array([1, 2]) });
  harness.controller.handleOutputChunk({ buffer: new Uint8Array([3]) });
  await harness.controller.stop();
  assert.deepEqual([...fs.readFileSync(path.join(runDir, 'output-audio.webm'))], [1, 2, 3]);
});

test('production 화면 새로고침이 끝나지 않거나 실패하면 시간 제한 안에 이유를 남기고 멈춘다', async () => {
  for (const reloadBehavior of ['hang', 'reject']) {
    const harness = createHarness({ reloadBehavior });
    const startedAtMs = harness.clock.nowMs;
    const result = await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
    assert.equal(result.isOk, false, reloadBehavior);
    assert.match(result.message, /새로 불러오지 못했다/);
    const status = harness.controller.getStatus();
    assert.equal(status.phase, RUN_PHASE_MAP.failed);
    assert.deepEqual(status.errorList.map((error) => error.code), [RUN_ERROR_MAP.viewerReloadFailed]);
    assert.deepEqual(harness.callList, ['viewer.reload'], '모드·영상·캡처로 넘어가지 않는다');
    assert.equal(harness.finalizedList.length, 0, '결과 폴더를 만들기 전이다');
    if (reloadBehavior === 'hang') assert.ok(harness.clock.nowMs - startedAtMs >= VIEWER_RELOAD_TIMEOUT_MS);
    else assert.ok(harness.clock.nowMs - startedAtMs < VIEWER_RELOAD_TIMEOUT_MS);
  }
});

test('결과 폴더를 만들기 전에 실패하면 지난 실행 기록에 오류를 덧붙이지 않는다', async () => {
  const harness = createHarness({ startOutputError: 'NotAllowedError' });
  const first = await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  await harness.controller.stop();
  harness.optionMap.reloadBehavior = 'reject';
  assert.equal((await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true })).isOk, false);
  const status = harness.controller.getStatus();
  assert.deepEqual(status.errorList.map((error) => error.code), [RUN_ERROR_MAP.viewerReloadFailed]);
  assert.equal(status.runDir, null);
  assert.equal(status.lastRunDir, first.runDir);
});

test('결과 폴더 마무리가 실패해도 멈춰 있지 않고 이유를 알리며 다시 시작할 수 있다', async () => {
  const harness = createHarness({ finalizeError: 'EACCES: 결과 폴더를 만들 수 없다' });
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  const finished = harness.waitFinished();
  harness.controller.handlePlayerTime({ wallMs: harness.clock.nowMs, mediaMs: 60000, paused: false, ended: true });
  const result = await finished;
  assert.equal(result.isComplete, false);
  assert.equal(result.phase, RUN_PHASE_MAP.failed);
  assert.deepEqual(result.errorList.map((error) => error.code), [RUN_ERROR_MAP.finalizeFailed]);
  const status = harness.controller.getStatus();
  assert.equal(status.phase, RUN_PHASE_MAP.failed);
  assert.match(status.message, /EACCES/);
  assert.equal((await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true })).isOk, true);
  const stopResult = await harness.controller.stop();
  assert.equal(stopResult.isOk, true);
  assert.equal(stopResult.isComplete, false);
});

test('녹음 파일 쓰기에 실패하면 output_record_failed 로 남긴다', async () => {
  const failingFsApi = { writeFile: async () => {}, appendFile: async () => { throw new Error('디스크 가득 참'); } };
  const harness = createHarness({ createOutputWriter: ({ filePath }) => createOutputWriter({ filePath, fsApi: failingFsApi }) });
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  await harness.controller.handleOutputChunk({ buffer: new Uint8Array([1]) });
  await harness.controller.stop();
  const { errorList } = harness.finalizedList[0].run;
  assert.deepEqual(errorList.map((error) => error.code), [RUN_ERROR_MAP.outputRecordFailed]);
  assert.match(errorList[0].message, /디스크 가득 참/);
});

test('녹음 정지에 실패하면 실제 결과 폴더의 run.json 도 isComplete=false 다', async () => {
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-controller-record-'));
  const recordPath = path.join(recordDir, 'pipeline-1.jsonl');
  fs.writeFileSync(recordPath, `${JSON.stringify({ kind: 'asr', ts: 1, text: '말', sessionId: 'session-1' })}\n`);
  async function runOnce({ stopOutputError }) {
    const harness = createHarness({ recordPath, stopOutputError, finalize: finalizeRun });
    const { runDir } = await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
    harness.controller.handlePlayerTime({ wallMs: harness.clock.nowMs, mediaMs: 0, paused: false, ended: false });
    await harness.controller.handleOutputChunk({ buffer: new Uint8Array([1, 2, 3]) });
    const stopResult = await harness.controller.stop();
    return { stopResult, runInfo: JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) };
  }
  const okCase = await runOnce({ stopOutputError: null });
  assert.equal(okCase.runInfo.isComplete, true, JSON.stringify(okCase.runInfo.errorList));
  const failedCase = await runOnce({ stopOutputError: 'MediaRecorder 가 멈췄다' });
  assert.equal(failedCase.runInfo.isComplete, false);
  assert.equal(failedCase.stopResult.isComplete, false);
  assert.deepEqual(failedCase.runInfo.errorList.map((error) => error.code), [RUN_ERROR_MAP.outputRecordFailed]);
});

test('결과 폴더에 남는 실행 오류는 모두 결과물이 빠진 것으로 본다', () => {
  const runDirErrorList = [
    RUN_ERROR_MAP.roiMissing, RUN_ERROR_MAP.captureFailed, RUN_ERROR_MAP.outputRecordFailed,
    RUN_ERROR_MAP.sessionEndTimeout, RUN_ERROR_MAP.startFailed,
  ];
  for (const code of runDirErrorList) assert.ok(INCOMPLETE_CODE_LIST.includes(code), code);
});

test('대기 중에 정지하면 바로 마무리하고 대기가 끝나도 다시 마무리하지 않는다', async () => {
  // 마무리가 대기 한 바퀴보다 빨리 끝나는 경우: 세션이 바로 닫히고 녹음 쓰기도 바로 끝난다.
  const memoryWriter = () => ({ append: async () => {}, close: async () => ({ byteCount: 1, error: null }) });
  const harness = createHarness({ isSessionEndImmediate: true, createOutputWriter: memoryWriter });
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  harness.controller.handlePlayerTime({ wallMs: harness.clock.nowMs, mediaMs: 60000, paused: false, ended: true });
  assert.equal(harness.controller.getStatus().phase, RUN_PHASE_MAP.draining);
  assert.equal((await harness.controller.stop()).isOk, true);
  await flushImmediate({ count: 300 });
  assert.equal(harness.finalizedList.length, 1);
  assert.equal(harness.controller.getStatus().phase, RUN_PHASE_MAP.done);
});

test('production 화면 일시정지 버튼을 누르지 못하면 재생 화면을 다시 틀고 실행을 이어 간다', async () => {
  const harness = createHarness({ clickPauseResult: false });
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  harness.callList.length = 0;
  const result = await harness.controller.pause();
  assert.equal(result.isOk, false);
  assert.deepEqual(harness.callList, ['player.pause', 'viewer.clickPause', 'player.play']);
  assert.equal(harness.controller.getStatus().phase, RUN_PHASE_MAP.running);
});

test('다른 세션의 종료 알림은 이번 실행의 세션 종료로 보지 않는다', async () => {
  const harness = createHarness({ isSessionEnding: false });
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  harness.controller.sessionListener.onEnd({ isOk: true, sessionId: 'session-0' });
  await harness.controller.stop();
  assert.deepEqual(harness.finalizedList[0].run.errorList.map((error) => error.code), [RUN_ERROR_MAP.sessionEndTimeout]);
});

test('실행 기록에 git 정보·창 배치·ROI·영상 정보·녹음 시각이 실린다', async () => {
  const layout = { window: { width: 1920, height: 1080 } };
  const harness = createHarness({ getLayout: () => layout });
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  await harness.controller.stop();
  const { run } = harness.finalizedList[0];
  assert.deepEqual(run.git, { head: 'abc', productionMergeBase: 'def' });
  assert.deepEqual(run.layout, layout);
  assert.deepEqual(run.roiNormRect, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(run.videoInfo.durationMs, 60000);
  assert.equal(run.outputMimeType, 'audio/webm;codecs=opus');
  assert.ok(Number.isFinite(run.outputStartWallMs));
  assert.ok(Number.isFinite(run.outputStopWallMs));
  assert.ok(Number.isFinite(run.playStartWallMs));
});

test('녹음 쓰기는 쓴 바이트 수와 쓰기 실패를 닫을 때 알려 준다', async () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-output-writer-')), 'output-audio.webm');
  const writer = createOutputWriter({ filePath });
  writer.append(new Uint8Array([1, 2]));
  writer.append(new Uint8Array([3]));
  assert.deepEqual(await writer.close(), { byteCount: 3, error: null });
  assert.deepEqual([...fs.readFileSync(filePath)], [1, 2, 3]);

  const failingWriter = createOutputWriter({
    filePath: '/x', fsApi: { writeFile: async () => {}, appendFile: async () => { throw new Error('ENOSPC'); } },
  });
  failingWriter.append(new Uint8Array([1, 2]));
  const { byteCount, error } = await failingWriter.close();
  assert.equal(byteCount, 0);
  assert.match(error.message, /ENOSPC/);
});

const codeListOf = (run) => run.errorList.map((error) => error.code);

test('캡처가 정지 전에 스스로 끝났으면 capture_failed 로 남기고 열린 세션은 닫힐 때까지 기다린다', async () => {
  const neverEnded = createHarness();
  await neverEnded.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  neverEnded.setLive(false);
  neverEnded.callList.length = 0;
  const stoppedAtMs = neverEnded.clock.nowMs;
  await neverEnded.controller.stop();
  const neverEndedRun = neverEnded.finalizedList[0].run;
  assert.equal(neverEnded.callList.includes('viewer.clickToggle'), false, 'LIVE 가 아니면 시작 버튼을 누르지 않는다');
  assert.ok(neverEnded.finalizedList[0].atMs - stoppedAtMs >= SESSION_END_TIMEOUT_MS);
  assert.deepEqual(codeListOf(neverEndedRun), [RUN_ERROR_MAP.captureFailed, RUN_ERROR_MAP.sessionEndTimeout]);
  assert.match(neverEndedRun.errorList[0].message, /캡처가 정지 전에 끝났다/);

  const lateEnded = createHarness();
  await lateEnded.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  lateEnded.setLive(false);
  setImmediate(() => lateEnded.controller.sessionListener.onEnd({ isOk: true, sessionId: 'session-1' }));
  await lateEnded.controller.stop();
  const lateEndedRun = lateEnded.finalizedList[0].run;
  assert.deepEqual(codeListOf(lateEndedRun), [RUN_ERROR_MAP.captureFailed]);
  assert.equal(lateEndedRun.isSessionEnded, true);
});

test('LIVE 가 시간 제한 뒤에야 켜지면 마무리에서 정지 버튼을 눌러 세션을 닫는다', async () => {
  const harness = createHarness({ lateLiveDelayMs: LIVE_WAIT_MS + 2000 });
  const result = await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  assert.equal(result.isOk, false);
  const { run } = harness.finalizedList[0];
  assert.deepEqual(codeListOf(run), [RUN_ERROR_MAP.captureFailed]);
  assert.equal(run.sessionId, 'session-1');
  assert.equal(run.isSessionEnded, true, '늦게 열린 세션도 닫고 마무리한다');
  assert.equal(harness.callList.filter((call) => call === 'viewer.clickToggle').length, 2);
});

test('마무리 중 화면이 응답하지 않아도 시간 제한 뒤 기록을 남기고 결과 폴더까지 간다', async () => {
  const caseList = [
    { hangName: 'player.pause', codeList: [RUN_ERROR_MAP.pageUnresponsive] },
    { hangName: 'player.stopOutputRecording', codeList: [RUN_ERROR_MAP.outputRecordFailed] },
    { hangName: 'viewer.clickToggle', codeList: [RUN_ERROR_MAP.pageUnresponsive, RUN_ERROR_MAP.sessionEndTimeout] },
    { hangName: 'viewer.isLive', codeList: [RUN_ERROR_MAP.pageUnresponsive, RUN_ERROR_MAP.sessionEndTimeout] },
  ];
  for (const { hangName, codeList } of caseList) {
    const harness = createHarness();
    await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
    harness.optionMap.hangCallSet.add(hangName);
    const stopResult = await harness.controller.stop();
    assert.equal(stopResult.isOk, true, hangName);
    assert.equal(harness.finalizedList.length, 1, hangName);
    assert.deepEqual(codeListOf(harness.finalizedList[0].run), codeList, hangName);
    assert.equal(harness.controller.getStatus().phase, RUN_PHASE_MAP.done, hangName);
  }
});

test('시작 중 화면이 응답하지 않으면 준비 단계에 갇히지 않고 start_failed 로 멈춘다', async () => {
  const hangNameList = [
    'viewer.selectMode', 'player.setRoiEditing', 'player.load', 'player.startOutputRecording',
    'viewer.isStartable', 'viewer.clickToggle', 'viewer.isLive', 'player.play',
  ];
  for (const hangName of hangNameList) {
    const harness = createHarness({ hangCallList: [hangName] });
    const result = await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
    assert.equal(result.isOk, false, hangName);
    assert.match(result.message, /응답이 없었다/, hangName);
    const status = harness.controller.getStatus();
    assert.equal(status.phase, RUN_PHASE_MAP.failed, hangName);
    assert.equal(status.errorList[0].code, RUN_ERROR_MAP.startFailed, hangName);
  }
});

test('이번 실행의 세션이 열리기 전의 종료 알림과 세션 없음 응답은 세션 종료로 보지 않는다', async () => {
  let earlyHarness = null;
  earlyHarness = createHarness({
    isSessionEnding: false,
    beforeSessionStart: () => earlyHarness.controller.sessionListener.onEnd({ isOk: true, sessionId: 'session-0' }),
  });
  await earlyHarness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  await earlyHarness.controller.stop();
  assert.deepEqual(codeListOf(earlyHarness.finalizedList[0].run), [RUN_ERROR_MAP.sessionEndTimeout]);

  const notOkHarness = createHarness({ isSessionEnding: false });
  await notOkHarness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  notOkHarness.controller.sessionListener.onEnd({ isOk: false, message: '진행 중인 세션이 없습니다' });
  await notOkHarness.controller.stop();
  assert.deepEqual(codeListOf(notOkHarness.finalizedList[0].run), [RUN_ERROR_MAP.sessionEndTimeout]);
});

test('비어 있거나 잘못된 IPC 보고는 던지지 않고 버린다', async () => {
  const playbackList = [];
  const harness = createHarness({ onPlayback: (playback) => playbackList.push(playback) });
  await harness.controller.start({ videoPath: '/v.mp4', isEvalPreset: true });
  // 해설이 하나라도 있어야 재생 알림과 해설을 맞춰 보는 단계까지 간다.
  harness.controller.handleViewerEvent({ type: 'caption', ts: 1, text: '해설' });
  for (const report of [null, undefined, '해설', 42]) {
    assert.doesNotThrow(() => harness.controller.handleNarrationPlayback(report), String(report));
    assert.doesNotThrow(() => harness.controller.handleCaptureRequested(report), String(report));
    assert.doesNotThrow(() => harness.controller.handleOutputChunk(report), String(report));
  }
  assert.equal(playbackList.length, 0);
  harness.controller.handleNarrationPlayback({ ts: 1, text: '해설', wallMs: 1, durationMs: 1 });
  assert.equal(playbackList.length, 1);
  assert.equal(playbackList[0].caption.text, '해설');
  await harness.controller.stop();
  assert.equal(harness.finalizedList[0].run.playbackList.length, 1);
});
