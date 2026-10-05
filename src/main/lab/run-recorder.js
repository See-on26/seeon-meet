// 실험 1회 동안 lab main 이 받은 것을 메모리에 모은다. 결과 폴더는 finalize-run 이 이 기록으로 만든다.
// 실행 중이 아닐 때 오는 이벤트(실행 전 화면 조작, 마무리 중 늦게 온 해설)는 버린다.
function createRunRecorder({ now = Date.now } = {}) {
  let run = null;
  const isRecording = () => Boolean(run) && run.endedAtMs === null;

  function start({ runId, runDir, videoPath, videoInfo = null, mode, isEvalPreset, featureToggleMap, layout = null, git = null }) {
    run = {
      runId, runDir, videoPath, videoInfo, mode, isEvalPreset, featureToggleMap, layout, git,
      startedAtMs: now(), endedAtMs: null,
      captureRequestedWallMs: null, outputStartWallMs: null, outputStopWallMs: null, outputMimeType: null,
      playStartWallMs: null, videoEndedWallMs: null,
      sessionId: null, recordPath: null, isSessionEnded: false, roiNormRect: null,
      asrEventList: [], captionEventList: [], playbackList: [], playerTimeList: [], rendererDropList: [], errorList: [],
    };
    return run;
  }

  return {
    start,
    isRecording,
    markCaptureRequested({ wallMs }) {
      if (isRecording() && run.captureRequestedWallMs === null) run.captureRequestedWallMs = wallMs;
    },
    markSessionStart({ sessionId, recordPath }) {
      if (!isRecording()) return;
      run.sessionId = sessionId || null;
      run.recordPath = recordPath || null;
    },
    markSessionEnd() {
      if (run) run.isSessionEnded = true;
    },
    markOutputStart({ wallMs, mimeType = null }) {
      if (!isRecording()) return;
      run.outputStartWallMs = wallMs;
      run.outputMimeType = mimeType;
    },
    markOutputStop({ wallMs }) {
      if (run) run.outputStopWallMs = wallMs;
    },
    markPlayStart({ wallMs }) {
      if (isRecording() && run.playStartWallMs === null) run.playStartWallMs = wallMs;
    },
    markVideoEnded({ wallMs }) {
      if (isRecording() && run.videoEndedWallMs === null) run.videoEndedWallMs = wallMs;
    },
    setRoiNormRect(roiNormRect) {
      if (run) run.roiNormRect = roiNormRect;
    },
    addViewerEvent(event) {
      if (!isRecording() || !event) return;
      if (event.type === 'asr') run.asrEventList.push(event);
      else if (event.type === 'caption') run.captionEventList.push(event);
    },
    addPlayback(report) {
      if (isRecording() && report) run.playbackList.push(report);
    },
    addPlayerTime(report) {
      if (isRecording() && report) run.playerTimeList.push(report);
    },
    addRendererDrop(drop) {
      if (isRecording() && drop) run.rendererDropList.push(drop);
    },
    addError({ code, message }) {
      if (run) run.errorList.push({ code, message: String(message || ''), wallMs: now() });
    },
    // 지금 재생 중인 해설이 끝나는 벽시계 시각. 영상이 끝난 뒤 기다릴 때 해설이 잘리지 않게 쓴다.
    getPlayingUntilWallMs() {
      if (!run) return 0;
      // 시각이 빠진 보고 하나가 NaN 으로 전체 값을 망치지 않게 건너뛴다.
      return run.playbackList.reduce((latest, playback) => (Number.isFinite(playback.wallMs)
        ? Math.max(latest, playback.wallMs + (Number(playback.durationMs) || 0)) : latest), 0);
    },
    markEnded() {
      if (run && run.endedAtMs === null) run.endedAtMs = now();
    },
    getRun: () => run,
    snapshot: () => (run ? structuredClone(run) : null),
  };
}

module.exports = { createRunRecorder };
