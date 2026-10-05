const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { resolveRunMode, LAB_MODE_LABEL_MAP } = require('./lab-mode');
const { computeDrainTargetMs, DRAIN_POLL_MS } = require('./drain-policy');
const { buildFeatureTogglePreset } = require('./feature-toggle-preset');
const { buildRunDirName } = require('./export/run-dir-name');
const { RESULT_FILE_MAP } = require('./export/finalize-run');

const RUN_PHASE_MAP = {
  idle: 'idle',
  preparing: 'preparing',
  running: 'running',
  paused: 'paused',
  draining: 'draining',
  finalizing: 'finalizing',
  done: 'done',
  failed: 'failed',
};

// 결과 폴더를 만들기 전 실패(viewer 새로고침·모드·영상)는 조작 바 상태에만 남고,
// 그 뒤 실패는 run.json.errorList 에 남는다(finalize-run 의 INCOMPLETE_CODE_LIST 와 맞춘다).
// page_unresponsive 는 마무리 중 화면 호출이 응답하지 않았다는 기록일 뿐이다. 그 때문에 빠진 것은
// session_end_timeout·output_record_failed·session_unknown 이 따로 알린다.
const RUN_ERROR_MAP = {
  viewerReloadFailed: 'viewer_reload_failed',
  modeSelectFailed: 'mode_select_failed',
  videoLoadFailed: 'video_load_failed',
  roiMissing: 'roi_missing',
  captureFailed: 'capture_failed',
  outputRecordFailed: 'output_record_failed',
  sessionEndTimeout: 'session_end_timeout',
  startFailed: 'start_failed',
  finalizeFailed: 'finalize_failed',
  pageUnresponsive: 'page_unresponsive',
};

const RUN_ERROR_CODE_LIST = Object.values(RUN_ERROR_MAP);

const STARTABLE_WAIT_MS = 8000;
const LIVE_WAIT_MS = 15000;
const SESSION_END_TIMEOUT_MS = 60000;
// viewer 새로고침은 페이지가 못 열리거나 화면이 사라지면 끝나지 않는다. 그때도 실행이 멈춰 서지 않게 한다.
const VIEWER_RELOAD_TIMEOUT_MS = 15000;
// 화면 호출(상태 확인·버튼 누르기·재생 화면 조작) 한 번의 응답 제한. 응답 없는 화면 때문에 준비·마무리에 갇히지 않게 한다.
const PAGE_CALL_TIMEOUT_MS = 3000;
const VIDEO_LOAD_TIMEOUT_MS = 30000;
// 녹음 시작은 화면 캡처 허가·MediaRecorder 시작을, 정지는 마지막 조각 전송을 기다리므로 조금 더 준다.
const OUTPUT_START_TIMEOUT_MS = 10000;
const OUTPUT_STOP_TIMEOUT_MS = 10000;
const POLL_MS = 100;

const IDLE_PHASE_LIST = [RUN_PHASE_MAP.idle, RUN_PHASE_MAP.done, RUN_PHASE_MAP.failed];
const ACTIVE_PHASE_LIST = [RUN_PHASE_MAP.running, RUN_PHASE_MAP.paused, RUN_PHASE_MAP.draining];

const isReportObject = (report) => Boolean(report) && typeof report === 'object';

function createLabError({ code, message }) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 실험 1회의 순서를 맡는다: 준비(평가 설정·모드·영상) → 녹음·캡처 시작 → 재생 → 영상 끝 → 대기 → 정지 → 결과 폴더.
function createRunController({
  viewerDriver, playerDriver, recorder, finalize, readGit, createOutputWriter, setViewerPreset,
  labRootDir, modelConfig, getLayout = () => null, notify = () => {}, onPlayback = () => {}, onRunFinished = () => {},
  mkdir = (dir) => fs.promises.mkdir(dir, { recursive: true }),
  now = Date.now, wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) {
  let phase = RUN_PHASE_MAP.idle;
  let phaseMessage = '';
  let runMode = null;
  let runDir = null;
  let lastRunDir = null;
  let outputWriter = null;
  let isFinishing = false;
  // 이번 실행의 기록. 결과 폴더를 만들기 전에 실패하면 null 이고, 그 오류는 startErrorList 에만 남는다
  // (지난 실행 기록에 덧붙지 않게).
  let activeRun = null;
  let startErrorList = [];
  // 마무리 한 번 동안 이미 알린 무응답 화면 호출. 반복 확인이 같은 오류를 계속 쌓지 않게 한다.
  let reportedUnresponsiveSet = new Set();

  function getStatus() {
    const errorList = activeRun ? activeRun.errorList : startErrorList;
    return {
      phase, message: phaseMessage, mode: runMode, runDir, lastRunDir,
      errorList: errorList.map((error) => ({ ...error })),
    };
  }

  function setPhase(nextPhase, message = '') {
    phase = nextPhase;
    phaseMessage = message;
    notify(getStatus());
  }

  const hasRunError = (code) => Boolean(activeRun?.errorList.some((error) => error.code === code));

  // 작업이 timeoutMs 안에 끝나는지 본다. 시간은 주입한 now·wait 로만 재므로 가짜 시계에서도 바로 끝난다.
  // 작업이 먼저 끝나면 그 결과를 바로 돌려주고, 남은 시간 제한 반복은 다음 바퀴에 스스로 멈춘다.
  async function settleWithin({ task, timeoutMs }) {
    let isSettled = false;
    const settledPromise = Promise.resolve()
      .then(task)
      .then((value) => ({ isTimedOut: false, value }), (error) => ({ isTimedOut: false, error }))
      .finally(() => { isSettled = true; });
    const timeoutPromise = (async () => {
      const deadlineMs = now() + timeoutMs;
      // 곧바로 끝나는 호출은 시간 제한 반복을 돌리지 않는다.
      await wait(0);
      while (!isSettled && now() < deadlineMs) await wait(POLL_MS);
      return isSettled ? settledPromise : { isTimedOut: true };
    })();
    return Promise.race([settledPromise, timeoutPromise]);
  }

  // 시작 단계의 화면 호출. 응답이 없으면 start_failed 로 시작을 멈춘다(준비 중에는 정지를 받지 않으므로 여기서 끊는다).
  // 응답이 오면 { value } 또는 { error } 를 돌려주고, 실패를 어떻게 볼지는 부르는 쪽이 정한다.
  async function callForStart({ label, task, timeoutMs = PAGE_CALL_TIMEOUT_MS }) {
    const outcome = await settleWithin({ task, timeoutMs });
    if (outcome.isTimedOut) {
      throw createLabError({ code: RUN_ERROR_MAP.startFailed, message: `${label}: ${timeoutMs / 1000}초 안에 응답이 없었다` });
    }
    return outcome;
  }

  // 마무리 단계의 화면 호출. 응답이 없거나 화면이 사라져도 한 번만 기록하고 결과 폴더까지 간다.
  async function callForFinish({ label, task }) {
    const outcome = await settleWithin({ task, timeoutMs: PAGE_CALL_TIMEOUT_MS });
    if (!outcome.isTimedOut && !outcome.error) return { isOk: true, value: outcome.value };
    if (!reportedUnresponsiveSet.has(label)) {
      reportedUnresponsiveSet.add(label);
      const reason = outcome.isTimedOut ? `${PAGE_CALL_TIMEOUT_MS / 1000}초 안에 응답이 없었다` : outcome.error.message;
      recorder.addError({ code: RUN_ERROR_MAP.pageUnresponsive, message: `${label}: ${reason}` });
    }
    return { isOk: false, value: null };
  }

  async function waitUntil({ label, check, timeoutMs }) {
    const deadlineMs = now() + timeoutMs;
    for (;;) {
      const outcome = await callForStart({ label, task: check });
      if (!outcome.error && outcome.value) return true;
      if (now() >= deadlineMs) return false;
      await wait(POLL_MS);
    }
  }

  async function prepareViewer({ isEvalPreset, mode }) {
    setViewerPreset({ isEvalPreset });
    const reload = await settleWithin({ task: () => viewerDriver.reload(), timeoutMs: VIEWER_RELOAD_TIMEOUT_MS });
    if (reload.isTimedOut || reload.error) {
      const reason = reload.isTimedOut ? `${VIEWER_RELOAD_TIMEOUT_MS / 1000}초 안에 끝나지 않았다` : reload.error.message;
      throw createLabError({ code: RUN_ERROR_MAP.viewerReloadFailed, message: `production 화면을 새로 불러오지 못했다 (${reason})` });
    }
    const select = await callForStart({ label: 'production 화면 모드 선택', task: () => viewerDriver.selectMode({ mode }) });
    const selectedMode = select.error ? `오류: ${select.error.message}` : select.value;
    if (selectedMode !== mode) {
      throw createLabError({ code: RUN_ERROR_MAP.modeSelectFailed, message: `production 화면을 ${mode} 모드로 바꾸지 못했다 (지금 ${selectedMode})` });
    }
  }

  // 녹음을 시작하지 못해도(허가 거절 등) 실행은 이어 간다. 응답이 아예 없으면 재생 화면이 멈춘 것이라 시작을 멈춘다.
  async function startOutputRecording() {
    const start = await callForStart({
      label: '재생 화면 녹음 시작', task: () => playerDriver.startOutputRecording(), timeoutMs: OUTPUT_START_TIMEOUT_MS,
    });
    if (start.error || !start.value) {
      const reason = start.error ? start.error.message : '응답이 비었다';
      recorder.addError({ code: RUN_ERROR_MAP.outputRecordFailed, message: `viewer 소리 녹음 시작 실패: ${reason}` });
      return;
    }
    recorder.markOutputStart({ wallMs: start.value.startedWallMs, mimeType: start.value.mimeType });
  }

  async function startCapture() {
    if (!(await waitUntil({ label: 'production 화면 시작 가능 확인', check: () => viewerDriver.isStartable(), timeoutMs: STARTABLE_WAIT_MS }))) {
      throw createLabError({ code: RUN_ERROR_MAP.roiMissing, message: 'production 화면이 시작할 수 없다 — 재생 화면 ROI(roi-update)를 받지 못했다' });
    }
    await callForStart({ label: 'production 화면 시작 버튼', task: () => viewerDriver.clickToggle() });
    if (!(await waitUntil({ label: 'production 화면 LIVE 확인', check: () => viewerDriver.isLive(), timeoutMs: LIVE_WAIT_MS }))) {
      throw createLabError({ code: RUN_ERROR_MAP.captureFailed, message: 'production 화면이 재생 화면 캡처를 시작하지 못했다' });
    }
  }

  async function start({ videoPath, mode: requestedMode = null, isEvalPreset = true }) {
    if (!IDLE_PHASE_LIST.includes(phase)) return { isOk: false, message: '이미 실행 중이다' };
    if (!videoPath) return { isOk: false, message: '영상 파일을 먼저 고른다' };
    const mode = resolveRunMode({ requestedMode, isEvalPreset });
    runMode = mode;
    runDir = null;
    activeRun = null;
    startErrorList = [];
    setPhase(RUN_PHASE_MAP.preparing, '준비 중 — production 화면 설정·영상 불러오기');
    try {
      await prepareViewer({ isEvalPreset, mode });
      // 편집 테두리가 캡처 이미지에 들어가지 않게 시작 전에 끈다.
      const roi = await callForStart({ label: '재생 화면 ROI 편집 끄기', task: () => playerDriver.setRoiEditing({ isEditing: false }) });
      if (roi.error) throw roi.error;
      const load = await callForStart({
        label: '재생 화면 영상 불러오기', task: () => playerDriver.load({ fileUrl: pathToFileURL(videoPath).href }), timeoutMs: VIDEO_LOAD_TIMEOUT_MS,
      });
      if (load.error) {
        throw createLabError({ code: RUN_ERROR_MAP.videoLoadFailed, message: `영상을 불러오지 못했다: ${load.error.message}` });
      }
      const runId = buildRunDirName({ startedAtMs: now(), videoPath });
      const nextRunDir = path.join(labRootDir, runId);
      try {
        await mkdir(nextRunDir);
      } catch (error) {
        throw createLabError({ code: RUN_ERROR_MAP.startFailed, message: `결과 폴더를 만들지 못했다: ${error.message}` });
      }
      runDir = nextRunDir;
      const git = await Promise.resolve().then(() => readGit()).catch(() => null);
      activeRun = recorder.start({
        runId, runDir, videoPath, videoInfo: load.value ?? null, mode, isEvalPreset,
        featureToggleMap: buildFeatureTogglePreset({ isEvalPreset }), layout: getLayout(), git,
      });
      recorder.setRoiNormRect(roi.value?.roiNormRect ?? null);
      outputWriter = createOutputWriter({ filePath: path.join(runDir, RESULT_FILE_MAP.outputAudio) });
      await startOutputRecording();
      await startCapture();
      const play = await callForStart({ label: '재생 화면 재생', task: () => playerDriver.play() });
      if (play.error) throw play.error;
      recorder.markPlayStart({ wallMs: now() });
      setPhase(RUN_PHASE_MAP.running, `${LAB_MODE_LABEL_MAP[mode]} 모드로 실행 중`);
      return { isOk: true, runDir };
    } catch (error) {
      const code = RUN_ERROR_CODE_LIST.includes(error.code) ? error.code : RUN_ERROR_MAP.startFailed;
      if (activeRun) {
        recorder.addError({ code, message: error.message });
        await finish({ finalPhase: RUN_PHASE_MAP.failed, message: error.message });
      } else {
        startErrorList.push({ code, message: error.message, wallMs: now() });
        setPhase(RUN_PHASE_MAP.failed, error.message);
      }
      return { isOk: false, message: error.message };
    }
  }

  async function drainAndFinish() {
    setPhase(RUN_PHASE_MAP.draining, '영상 끝 — 지연 재생과 남은 해설을 기다리는 중');
    const drainRun = activeRun;
    const endedWallMs = drainRun.videoEndedWallMs;
    for (;;) {
      // 기다리는 동안 정지를 누르면 그쪽이 마무리한다. 깨어나서 다시 마무리하지 않는다.
      if (phase !== RUN_PHASE_MAP.draining || activeRun !== drainRun) return;
      const targetMs = computeDrainTargetMs({ endedWallMs, mode: runMode, playingUntilWallMs: recorder.getPlayingUntilWallMs() });
      const remainingMs = targetMs - now();
      if (remainingMs <= 0) break;
      await wait(Math.min(remainingMs, DRAIN_POLL_MS));
    }
    await finish({ finalPhase: RUN_PHASE_MAP.done });
  }

  // 재생 화면은 마지막 녹음 조각을 다 보낸 뒤에 정지 응답을 준다. 그래서 응답 뒤에 녹음 파일을 닫는다.
  async function stopOutputRecording() {
    const stop = await settleWithin({ task: () => playerDriver.stopOutputRecording(), timeoutMs: OUTPUT_STOP_TIMEOUT_MS });
    if (stop.isTimedOut || stop.error) {
      const reason = stop.isTimedOut ? `${OUTPUT_STOP_TIMEOUT_MS / 1000}초 안에 응답이 없었다` : stop.error.message;
      recorder.addError({ code: RUN_ERROR_MAP.outputRecordFailed, message: `viewer 소리 녹음 정지 실패: ${reason}` });
    } else {
      recorder.markOutputStop({ wallMs: stop.value?.stoppedWallMs ?? now() });
    }
    const writeResult = outputWriter ? await outputWriter.close() : null;
    outputWriter = null;
    if (writeResult?.error) {
      recorder.addError({ code: RUN_ERROR_MAP.outputRecordFailed, message: `viewer 소리 녹음 파일 쓰기 실패: ${writeResult.error.message}` });
    }
  }

  // viewer 정지 버튼을 누르면 ASR 드레인 뒤 파이프라인 세션이 닫힌다. 닫혀야 세션 jsonl 이 다 쓰인다.
  // - 정지할 때 LIVE 면 정지 버튼을 한 번 누르고 세션이 닫힐 때까지 기다린다.
  // - 이미 LIVE 였던 캡처가 정지 전에 끝나 있으면 capture_failed 로 남기고, 열린 세션은 그래도 기다린다.
  // - 캡처를 요청했는데 아직 LIVE 가 아니면(시작 대기 시간을 넘긴 늦은 LIVE) 조금 더 지켜보다 LIVE 가 되면 정지 버튼을 누른다.
  async function stopViewerCapture() {
    const run = activeRun;
    const hasGoneLive = run.playStartWallMs !== null || run.sessionId !== null;
    let isStopClicked = false;
    // LIVE 면 정지 버튼을 누르고 true, 아니면 false, 화면이 응답하지 않으면 null.
    async function pressStopIfLive() {
      const live = await callForFinish({ label: 'production 화면 LIVE 확인', task: () => viewerDriver.isLive() });
      if (!live.isOk) return null;
      if (live.value !== true) return false;
      isStopClicked = true;
      await callForFinish({ label: 'production 화면 정지 버튼', task: () => viewerDriver.clickToggle() });
      return true;
    }

    const isLiveAtStop = await pressStopIfLive();
    if (isLiveAtStop === false && hasGoneLive && !hasRunError(RUN_ERROR_MAP.captureFailed)) {
      recorder.addError({ code: RUN_ERROR_MAP.captureFailed, message: '캡처가 정지 전에 끝났다' });
    }
    const isSessionPending = run.sessionId !== null || run.captureRequestedWallMs !== null;
    if (run.isSessionEnded || !(isStopClicked || isSessionPending)) return;

    const waitStartMs = now();
    for (;;) {
      if (run.isSessionEnded) return;
      if (!isStopClicked) await pressStopIfLive();
      const elapsedMs = now() - waitStartMs;
      // 늦은 LIVE 를 기다렸는데 끝내 세션이 열리지 않았으면 닫을 것이 없다.
      if (!isStopClicked && run.sessionId === null && elapsedMs >= LIVE_WAIT_MS) return;
      if (elapsedMs >= SESSION_END_TIMEOUT_MS) break;
      await wait(POLL_MS);
    }
    recorder.addError({ code: RUN_ERROR_MAP.sessionEndTimeout, message: `파이프라인 세션이 ${SESSION_END_TIMEOUT_MS / 1000}초 안에 닫히지 않았다` });
  }

  // 결과 폴더 마무리가 실패해도(폴더를 못 만듦 등) 실행이 끝난 것으로 보고 이유를 알린다.
  async function finalizeSafely() {
    try {
      return { result: await finalize({ run: recorder.snapshot(), modelConfig }), failMessage: null };
    } catch (error) {
      const failMessage = `결과 폴더를 쓰지 못했다: ${error.message}`;
      recorder.addError({ code: RUN_ERROR_MAP.finalizeFailed, message: failMessage });
      return {
        result: { isComplete: false, errorList: activeRun.errorList.map((runError) => ({ ...runError })), runDir },
        failMessage,
      };
    }
  }

  async function finish({ finalPhase, message = '' }) {
    if (isFinishing) return null;
    isFinishing = true;
    reportedUnresponsiveSet = new Set();
    try {
      setPhase(RUN_PHASE_MAP.finalizing, '결과 폴더 정리 중');
      await stopOutputRecording();
      await stopViewerCapture();
      await callForFinish({ label: '재생 화면 일시정지', task: () => playerDriver.pause() });
      recorder.markEnded();
      const { result, failMessage } = await finalizeSafely();
      lastRunDir = runDir;
      const resolvedPhase = failMessage ? RUN_PHASE_MAP.failed : finalPhase;
      const completeText = failMessage
        || (result.isComplete ? '결과 폴더 완료' : '결과 폴더에 빠진 것이 있다 (run.json errorList)');
      setPhase(resolvedPhase, message ? `${message} · ${completeText}` : completeText);
      const finished = { ...result, phase: resolvedPhase };
      onRunFinished(finished);
      return finished;
    } finally {
      isFinishing = false;
    }
  }

  async function pause() {
    if (phase !== RUN_PHASE_MAP.running) return { isOk: false, message: '실행 중이 아니다' };
    try {
      await playerDriver.pause();
    } catch (error) {
      return { isOk: false, message: `일시정지 실패: ${error.message}` };
    }
    if (!(await viewerDriver.clickPause().catch(() => false))) {
      // 한쪽만 멈추면 시각이 어긋난다. 재생 화면을 다시 틀어 둘을 맞춘다.
      await playerDriver.play().catch(() => {});
      return { isOk: false, message: 'production 화면을 함께 멈추지 못해 그대로 재생한다' };
    }
    setPhase(RUN_PHASE_MAP.paused, '일시정지 — 재생 화면과 production 화면을 함께 멈췄다');
    return { isOk: true };
  }

  async function resume() {
    if (phase !== RUN_PHASE_MAP.paused) return { isOk: false, message: '일시정지 상태가 아니다' };
    if (!(await viewerDriver.clickPause().catch(() => false))) {
      return { isOk: false, message: 'production 화면을 다시 돌리지 못해 일시정지를 유지한다' };
    }
    try {
      await playerDriver.play();
    } catch (error) {
      // 한쪽만 다시 돌면 시각이 어긋난다. production 화면을 다시 멈춘다.
      await viewerDriver.clickPause().catch(() => false);
      return { isOk: false, message: `재개 실패: ${error.message}` };
    }
    setPhase(RUN_PHASE_MAP.running, `${LAB_MODE_LABEL_MAP[runMode]} 모드로 실행 중`);
    return { isOk: true };
  }

  async function stop() {
    if (!ACTIVE_PHASE_LIST.includes(phase)) return { isOk: false, message: '실행 중이 아니다' };
    const result = await finish({ finalPhase: RUN_PHASE_MAP.done, message: '사용자가 정지' });
    if (!result) return { isOk: false, message: '이미 마무리 중이다' };
    return { isOk: true, runDir: result.runDir ?? runDir, isComplete: result.isComplete };
  }

  async function setRoiEditing({ isEditing }) {
    if (!IDLE_PHASE_LIST.includes(phase)) return { isOk: false, message: '실행 중에는 ROI 를 바꾸지 않는다' };
    try {
      return { isOk: true, ...(await playerDriver.setRoiEditing({ isEditing })) };
    } catch (error) {
      return { isOk: false, message: `ROI 편집 전환 실패: ${error.message}` };
    }
  }

  // 아래 handle* 는 ipcMain 리스너에서 바로 불린다. 여기서 던지면 main 프로세스 예외가 되므로 이상한 보고는 버린다.
  return {
    start, pause, resume, stop, setRoiEditing, getStatus,
    handlePlayerTime(report) {
      recorder.addPlayerTime(report);
      if (report?.ended && phase === RUN_PHASE_MAP.running) {
        recorder.markVideoEnded({ wallMs: Number.isFinite(report.wallMs) ? report.wallMs : now() });
        drainAndFinish().catch((error) => setPhase(RUN_PHASE_MAP.failed, `마무리 실패: ${error.message}`));
      }
    },
    handleViewerEvent: (event) => recorder.addViewerEvent(event),
    handleNarrationPlayback(report) {
      if (!isReportObject(report)) return;
      recorder.addPlayback(report);
      const caption = recorder.getRun()?.captionEventList.find((event) => event.ts === report.ts && event.text === report.text) || null;
      onPlayback({ playback: report, caption });
    },
    handleRendererDrop: (drop) => recorder.addRendererDrop(drop),
    handleCaptureRequested(request) {
      if (Number.isFinite(request?.wallMs)) recorder.markCaptureRequested({ wallMs: request.wallMs });
    },
    // 재생 화면은 이 약속이 끝나야 다음 조각을 보낸다(invoke). 그래서 쓰기가 끝날 때까지 기다리게 돌려준다.
    handleOutputChunk(chunk) {
      if (!isReportObject(chunk) || !chunk.buffer) return undefined;
      return outputWriter?.append(chunk.buffer);
    },
    handleOutputState(state) {
      if (state?.phase === 'error') recorder.addError({ code: RUN_ERROR_MAP.outputRecordFailed, message: state.message });
    },
    sessionListener: {
      onStart(result) {
        if (result?.isOk) recorder.markSessionStart({ sessionId: result.sessionId, recordPath: result.recordPath });
      },
      // 이번 실행의 세션이 열린 뒤 그 세션이 닫힌 알림만 센다. 지난 세션의 늦은 종료와
      // "진행 중인 세션이 없다"({ isOk:false }) 응답은 종료로 보지 않는다.
      onEnd(result) {
        const run = recorder.getRun();
        if (!run?.sessionId || !result?.isOk) return;
        if (result.sessionId && result.sessionId !== run.sessionId) return;
        recorder.markSessionEnd();
      },
    },
  };
}

module.exports = {
  createRunController, RUN_PHASE_MAP, RUN_ERROR_MAP, SESSION_END_TIMEOUT_MS, STARTABLE_WAIT_MS, LIVE_WAIT_MS,
  VIEWER_RELOAD_TIMEOUT_MS, PAGE_CALL_TIMEOUT_MS, VIDEO_LOAD_TIMEOUT_MS, OUTPUT_START_TIMEOUT_MS, OUTPUT_STOP_TIMEOUT_MS,
};
