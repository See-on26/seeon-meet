const { buildTimeMap, wallToMediaMs } = require('../time-map');
const { buildFlowView, summarizeTrackList } = require('./flow-builder');

// 흐름 창에 보내는 갱신값. 실행 기록기가 모은 debug(받은 시각 포함)·해설·재생 알림·버린 해설·시각 보고로 만든다.
// 실행이 끝난 뒤에도 다음 실행을 시작할 때까지 그 실행의 흐름을 보여 준다.
function buildLiveFlowSnapshot({ run, nowWallMs }) {
  if (!run) {
    return {
      runId: null, isRecording: false, flowList: [], trackList: summarizeTrackList({ nowWallMs }), sessionInfoList: [], asrList: [],
    };
  }
  const timeMap = buildTimeMap({ reportList: run.playerTimeList || [] });
  const debugList = run.debugEventList || [];
  const playbackList = run.playbackList || [];
  const isRecording = run.endedAtMs === null || run.endedAtMs === undefined;
  const view = buildFlowView({
    debugList,
    captionEventList: run.captionEventList || [],
    playbackList,
    droppedList: run.rendererDropList || [],
    toMediaMs: (wallMs) => wallToMediaMs({ timeMap, wallMs }),
    isFinal: !isRecording,
  });
  return {
    runId: run.runId ?? null,
    isRecording,
    flowList: view.flowList,
    trackList: summarizeTrackList({ debugList, playbackList, nowWallMs }),
    sessionInfoList: view.sessionInfoList,
    asrList: view.asrList,
  };
}

// 세션 기록의 버린 해설(narration isEmitted=false)을 흐름 빌더의 버린 목록 꼴로 바꾼다.
function toNarrationDropList(recordList) {
  return recordList
    .filter((record) => record.kind === 'narration' && record.isEmitted === false)
    .map((record) => ({ ts: record.ts, text: record.text, reason: record.skipReason || null }));
}

// 결과 폴더 flow.json. debug 는 세션 기록(main·렌더러 모두 있음)을 쓰고, 해설·재생 알림·렌더러가 버린 해설은 실행 기록기 것을 쓴다.
function buildFlowFile({ recordList, run, toMediaMs }) {
  const view = buildFlowView({
    debugList: recordList.filter((record) => record.kind === 'debug'),
    captionEventList: run.captionEventList || [],
    playbackList: run.playbackList || [],
    droppedList: [...(run.rendererDropList || []), ...toNarrationDropList(recordList)],
    toMediaMs,
    isFinal: true,
  });
  return { flowList: view.flowList, sessionInfoList: view.sessionInfoList, asrList: view.asrList };
}

module.exports = { buildLiveFlowSnapshot, buildFlowFile, toNarrationDropList };
