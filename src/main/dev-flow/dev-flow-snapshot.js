const { buildFlowView, summarizeTrackList } = require('./flow-builder');
const { resolveCaptureStartWallMs } = require('./played-time');
const { buildTranscriptUtteranceList } = require('./transcript-utterance');

// 제품 흐름 창에 보내는 갱신값. 실험실 흐름 창과 같은 꼴이다.
// 제품에는 원본 영상이 없으므로 카드 시각은 캡처를 시작한 순간부터 잰 회의 경과 시각이다.
function buildDevFlowSnapshot({ session, nowWallMs }) {
  if (!session) {
    return {
      runId: null, isRecording: false, flowList: [], trackList: summarizeTrackList({ nowWallMs }), sessionInfoList: [], asrList: [],
    };
  }
  const { debugEventList: debugList, playbackList } = session;
  const captureStartWallMs = resolveCaptureStartWallMs({ captureRequestedWallMs: session.startedAtMs, playbackList });
  const toMediaMs = (wallMs) => (Number.isFinite(wallMs) && Number.isFinite(captureStartWallMs)
    ? Math.max(0, wallMs - captureStartWallMs) : null);
  const isRecording = session.endedAtMs === null;
  const view = buildFlowView({
    debugList,
    captionEventList: session.captionEventList,
    playbackList,
    droppedList: session.rendererDropList,
    toMediaMs,
    isFinal: !isRecording,
    captureStartWallMs,
    utteranceList: buildTranscriptUtteranceList({ asrEventList: session.asrEventList, toMediaMs }),
  });
  return {
    runId: session.sessionId ?? null,
    isRecording,
    flowList: view.flowList,
    trackList: summarizeTrackList({ debugList, playbackList, nowWallMs }),
    sessionInfoList: view.sessionInfoList,
    asrList: view.asrList,
  };
}

module.exports = { buildDevFlowSnapshot };
