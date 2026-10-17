// 해설이 들리지 못하고 버려진 사유.
const DROP_REASON_MAP = {
  noAudio: 'no_audio',
  notPlayed: 'not_played',
  suppressed: 'suppressed',
};

// 렌더러 버림 알림(reportNarrationDropped)의 사유 중 TTS 합성 실패.
const RENDERER_TTS_FAILED_REASON = 'tts_failed';

// 렌더러가 알린 버림 사유를 흐름·결과의 사유로 옮긴다. TTS 합성 실패는 "소리 없음"(no_audio)이고,
// 그 밖의 사유(delay_exceeded·leader_cancelled·dwell_cancelled·emit_failed·stopped·expired 등)는 그대로 둔다.
function resolveRendererDropReason(reason) {
  if (!reason) return null;
  return reason === RENDERER_TTS_FAILED_REASON ? DROP_REASON_MAP.noAudio : reason;
}

module.exports = { DROP_REASON_MAP, RENDERER_TTS_FAILED_REASON, resolveRendererDropReason };
