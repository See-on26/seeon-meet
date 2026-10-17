// 제품 개발자 모드 흐름 창용 기록기. 이번 회의(캡처 세션) 동안 main 이 받은 파이프라인 기록을 메모리에 모은다.
// 창을 회의 중간에 열어도 처음부터 보이도록 창과 상관없이 늘 모은다. 새 세션을 시작하면 비우고,
// 회의가 끝난 뒤에도 다음 회의 전까지 그 회의 흐름을 보여 준다.
// 한 시간 넘는 회의에서도 메모리가 계속 늘지 않게 종류마다 상한을 두고 오래된 것부터 뺀다.
const DEV_FLOW_LIST_LIMIT = {
  debug: 20000,
  caption: 3000,
  asr: 5000,
  playback: 3000,
  drop: 3000,
};

function pushWithLimit({ list, item, limit }) {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function createDevFlowRecorder({ now = Date.now, onChange = () => {} } = {}) {
  let session = null;

  function add({ listName, item, limit }) {
    if (!session || !item || typeof item !== 'object') return;
    pushWithLimit({ list: session[listName], item, limit });
    onChange();
  }

  // main 기록의 ts 는 결정 시각이라 언제 받았는지(receivedWallMs)를 함께 적는다(신호등이 최근 기록을 고를 때 쓴다).
  function addDebug(entry) {
    if (!entry || typeof entry !== 'object') return;
    const { type, ...rest } = entry;
    add({ listName: 'debugEventList', item: { ...rest, receivedWallMs: now() }, limit: DEV_FLOW_LIST_LIMIT.debug });
  }

  return {
    start({ sessionId, mode = null }) {
      session = {
        sessionId, mode, startedAtMs: now(), endedAtMs: null,
        debugEventList: [], captionEventList: [], asrEventList: [], playbackList: [], rendererDropList: [],
      };
      onChange();
    },
    addDebug,
    // viewer 로 보내는 pipeline-event 중 흐름에 쓰는 것만 담는다. 캡션에 음성 데이터가 실려 와도 크므로 빼고 담는다.
    addPipelineEvent(payload) {
      if (!payload) return;
      if (payload.type === 'debug') {
        addDebug(payload);
      } else if (payload.type === 'caption') {
        const { wavData, ...caption } = payload;
        add({ listName: 'captionEventList', item: caption, limit: DEV_FLOW_LIST_LIMIT.caption });
      } else if (payload.type === 'asr') {
        const { ts, endTs = null, text = '', segmentList = [] } = payload;
        add({ listName: 'asrEventList', item: { ts, endTs, text, segmentList }, limit: DEV_FLOW_LIST_LIMIT.asr });
      }
    },
    addPlayback: (report) => add({ listName: 'playbackList', item: report, limit: DEV_FLOW_LIST_LIMIT.playback }),
    addRendererDrop: (drop) => add({ listName: 'rendererDropList', item: drop, limit: DEV_FLOW_LIST_LIMIT.drop }),
    markEnded() {
      if (session && session.endedAtMs === null) {
        session.endedAtMs = now();
        onChange();
      }
    },
    getSession: () => session,
  };
}

module.exports = { createDevFlowRecorder, DEV_FLOW_LIST_LIMIT };
