// viewer 가 받은 pipeline-event 중 실험 결과와 흐름 창에 필요한 것(asr·caption·debug)만 lab main 으로 넘긴다.
// 해설 음성 데이터는 크므로 빼고, 있었는지와 길이만 싣는다.
const FORWARDED_TYPE_LIST = ['asr', 'caption', 'debug'];
const WAV_HEADER_MIN_BYTES = 44;

function readTag(view, offset) {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

// RIFF WAV 의 fmt 청크 byteRate 와 data 청크 크기로 길이를 구한다.
function readWavDurationMs(bytes) {
  if (!bytes || bytes.byteLength < WAV_HEADER_MIN_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') return null;
  let offset = 12;
  let byteRate = null;
  while (offset + 8 <= bytes.byteLength) {
    const tag = readTag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (tag === 'fmt ' && bodyOffset + 12 <= bytes.byteLength) byteRate = view.getUint32(bodyOffset + 8, true);
    if (tag === 'data') {
      if (!byteRate) return null;
      return Math.round((Math.min(size, bytes.byteLength - bodyOffset) / byteRate) * 1000);
    }
    offset = bodyOffset + size + (size % 2);
  }
  return null;
}

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
  const { wavData, ...rest } = payload;
  return {
    ...rest,
    hasAudio: Boolean(wavData && wavData.byteLength),
    audioDurationMs: wavData ? readWavDurationMs(wavData) : null,
  };
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

module.exports = { readWavDurationMs, toForwardedPipelineEvent, buildPlaybackReport };
