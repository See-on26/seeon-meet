const { MODE_DELAY_MS_MAP, NARRATION_QUEUE_TTL_MS } = require('./lab-mode');

// 영상이 끝나도 지연 재생·생성 중인 해설·재생 대기 줄이 남는다. "모드 지연 + 대기 줄 TTL + 여유" 만큼 기다린다.
// 여유는 VLM 생성·TTS 합성(수 초~10초)을 덮는 값이다.
const DRAIN_MARGIN_MS = 15000;
// 마지막 해설이 끝난 뒤 녹음에 남길 꼬리.
const DRAIN_TAIL_MS = 1000;
const DRAIN_POLL_MS = 500;

function computeDrainDeadlineMs({ endedWallMs, mode }) {
  return endedWallMs + (MODE_DELAY_MS_MAP[mode] ?? 0) + NARRATION_QUEUE_TTL_MS + DRAIN_MARGIN_MS;
}

// 해설이 재생 중이면 끝날 때까지 더 기다린다.
function computeDrainTargetMs({ endedWallMs, mode, playingUntilWallMs = 0 }) {
  return Math.max(computeDrainDeadlineMs({ endedWallMs, mode }), playingUntilWallMs + DRAIN_TAIL_MS);
}

module.exports = { computeDrainDeadlineMs, computeDrainTargetMs, DRAIN_MARGIN_MS, DRAIN_TAIL_MS, DRAIN_POLL_MS };
