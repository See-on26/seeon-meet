// 자막 창 줄 고르기. 받아쓰기 줄은 사용자가 그 말을 들은 순간에, AD 는 들리기 시작할 때 낸다.
// 교차 모드는 회의를 늦게 들으므로 viewer 가 0.25초마다 보내는 지연 재생 위치가 그 말의 영상 시각에 닿을 때 낸다.
const SUBTITLE_KIND_MAP = {
  meeting: 'meeting',
  meetingFast: 'meeting_fast',
  narration: 'narration',
};
// 따라잡기 배속(1.0~1.8)과 1배를 가른다. 재생 속도 값의 작은 흔들림은 1배로 본다.
const FAST_PLAYBACK_RATE_MIN = 1.001;

function wallToVideoTimeMs({ wallTs, nowWallTs, nowVideoTimeMs }) {
  if (!Number.isFinite(wallTs) || !Number.isFinite(nowWallTs) || !Number.isFinite(nowVideoTimeMs)) return null;
  return Math.max(0, nowVideoTimeMs - (nowWallTs - wallTs));
}

// ASR 조각(벽시계 시각)을 세그먼트마다 한 줄로 나누고 그 말이 시작한 영상 시각을 붙인다. 세그먼트가 없으면 조각 전체가 한 줄이다.
function buildTranscriptLineList({ text, chunkStartTs, chunkEndTs, segmentList = [], nowWallTs, nowVideoTimeMs }) {
  const toVideoTimeMs = (wallTs) => wallToVideoTimeMs({ wallTs, nowWallTs, nowVideoTimeMs });
  const timedList = (Array.isArray(segmentList) ? segmentList : [])
    .filter((segment) => Number.isFinite(segment?.startSec) && String(segment.text || '').trim());
  if (timedList.length && Number.isFinite(chunkStartTs)) {
    return timedList.map((segment) => {
      const wallTs = chunkStartTs + segment.startSec * 1000;
      const clampedWallTs = Number.isFinite(chunkEndTs) ? Math.min(wallTs, chunkEndTs) : wallTs;
      return { text: String(segment.text).trim(), startVideoTimeMs: toVideoTimeMs(clampedWallTs) };
    });
  }
  const trimmed = String(text || '').trim();
  return trimmed ? [{ text: trimmed, startVideoTimeMs: toVideoTimeMs(chunkStartTs) }] : [];
}

function createSubtitleFeed({ onLine }) {
  let pendingList = [];
  let listen = null;
  let sequence = 0;

  const emit = ({ kind, text }) => {
    sequence += 1;
    onLine({ id: `${sequence}`, kind, text });
  };

  // 지연 재생이 없으면(동시 모드) 오는 대로, 있으면 들은 위치가 닿은 줄만 낸다. 들은 위치를 아직 모르면 기다린다.
  function flush() {
    if (!listen) return;
    const isFast = listen.playbackRate >= FAST_PLAYBACK_RATE_MIN;
    const isHeard = (line) => !listen.isDelayed || !Number.isFinite(line.startVideoTimeMs)
      || (Number.isFinite(listen.delayedVideoTimeMs) && line.startVideoTimeMs <= listen.delayedVideoTimeMs);
    const heardList = pendingList.filter(isHeard);
    if (!heardList.length) return;
    pendingList = pendingList.filter((line) => !isHeard(line));
    const kind = listen.isDelayed && isFast ? SUBTITLE_KIND_MAP.meetingFast : SUBTITLE_KIND_MAP.meeting;
    for (const line of heardList) emit({ kind, text: line.text });
  }

  return {
    addTranscript({ lineList = [] }) {
      pendingList = [...pendingList, ...lineList.filter((line) => line?.text)]
        .sort((lineA, lineB) => (lineA.startVideoTimeMs ?? 0) - (lineB.startVideoTimeMs ?? 0));
      flush();
    },
    updateListen({ isDelayed = false, delayedVideoTimeMs = null, playbackRate = 1 } = {}) {
      listen = { isDelayed: Boolean(isDelayed), delayedVideoTimeMs, playbackRate: Number.isFinite(playbackRate) ? playbackRate : 1 };
      flush();
    },
    addNarration({ text }) {
      const trimmed = String(text || '').trim();
      if (trimmed) emit({ kind: SUBTITLE_KIND_MAP.narration, text: trimmed });
    },
    reset() {
      pendingList = [];
      listen = null;
    },
  };
}

module.exports = { createSubtitleFeed, buildTranscriptLineList, SUBTITLE_KIND_MAP, FAST_PLAYBACK_RATE_MIN };
