// 렌더러 재생 시작 알림({ entry, durationMs, wallMs, mode, playbackVideoTimeMs, liveVideoTimeMs })을 한 층으로 편다.
// 흐름은 엔트리의 ts·text 로 캡션과 짝짓고, 들은 위치(지연 재생 위치)로 들린 순간의 캡처 시각을 정한다.
function flattenPlaybackReport(info) {
  return {
    ...(info?.entry || {}),
    durationMs: Number.isFinite(info?.durationMs) ? info.durationMs : null,
    wallMs: info?.wallMs ?? null,
    mode: info?.mode ?? null,
    playbackVideoTimeMs: Number.isFinite(info?.playbackVideoTimeMs) ? info.playbackVideoTimeMs : null,
    liveVideoTimeMs: Number.isFinite(info?.liveVideoTimeMs) ? info.liveVideoTimeMs : null,
  };
}

module.exports = { flattenPlaybackReport };
