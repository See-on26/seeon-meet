// viewer 가 받은 pipeline-event 중 실험 결과와 흐름 창에 필요한 것(asr·caption·debug)만 lab main 으로 넘긴다.
// 캡션에는 음성이 없다 — 렌더러가 재생 차례가 오면 pipeline-tts 로 합성한다. 소리를 못 만들었으면 버림 알림
// (reportNarrationDropped, 사유 tts_failed)으로 오고, 들린 길이는 재생 시작 알림에 실린다.
const FORWARDED_TYPE_LIST = ['asr', 'caption', 'debug'];

function toForwardedPipelineEvent(payload) {
  if (!payload || !FORWARDED_TYPE_LIST.includes(payload.type)) return null;
  if (payload.type === 'asr') {
    return {
      type: 'asr', ts: payload.ts, endTs: payload.endTs ?? null, text: payload.text || '',
      segmentList: Array.isArray(payload.segmentList) ? payload.segmentList : [],
    };
  }
  if (payload.type === 'debug') {
    return {
      type: 'debug', stage: payload.stage ?? null, verdict: payload.verdict ?? null, reason: payload.reason ?? '',
      detail: payload.detail ?? '', narrationType: payload.narrationType ?? null, ts: payload.ts ?? null,
    };
  }
  // 캡션에 음성 데이터(wavData)가 실려 와도 크므로 넘기지 않는다.
  const { wavData, ...rest } = payload;
  return rest;
}

// main.js 가 보낸 재생 시작 알림({ entry, durationMs, wallMs, mode, playbackVideoTimeMs, liveVideoTimeMs })을 한 층으로 편다.
function buildPlaybackReport(info) {
  return {
    ...(info?.entry || {}),
    durationMs: Number.isFinite(info?.durationMs) ? info.durationMs : null,
    wallMs: info?.wallMs ?? null,
    mode: info?.mode ?? null,
    playbackVideoTimeMs: Number.isFinite(info?.playbackVideoTimeMs) ? info.playbackVideoTimeMs : null,
    liveVideoTimeMs: Number.isFinite(info?.liveVideoTimeMs) ? info.liveVideoTimeMs : null,
  };
}

module.exports = { toForwardedPipelineEvent, buildPlaybackReport };
