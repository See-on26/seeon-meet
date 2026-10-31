const { MODE_DELAY_MS_MAP } = require('./mode-delay');

function median(valueList) {
  const sortedList = [...valueList].sort((valueA, valueB) => valueA - valueB);
  const middle = sortedList.length >> 1;
  return sortedList.length % 2 ? sortedList[middle] : (sortedList[middle - 1] + sortedList[middle]) / 2;
}

// 캡처 영상 시각(captureSource.videoTimeMs) 0 이 벽시계로 언제인지. 재생 시작 알림마다 (벽시계 − 그때 영상 시각)이 실리므로
// 그 중앙값을 쓰고, 알림이 없으면 화면 캡처 처리기가 불린 시각으로 대신한다.
function resolveCaptureStartWallMs({ captureRequestedWallMs = null, playbackList = [] }) {
  const anchorList = playbackList
    .filter((playback) => Number.isFinite(playback.wallMs) && Number.isFinite(playback.liveVideoTimeMs) && playback.liveVideoTimeMs > 0)
    .map((playback) => playback.wallMs - playback.liveVideoTimeMs);
  if (anchorList.length) return median(anchorList);
  return Number.isFinite(captureRequestedWallMs) ? captureRequestedWallMs : null;
}

// 지연 버퍼는 지연 영상을 붙이기 전에 재생 위치를 0 으로 돌려준다. 버퍼가 차는 동안의 0 은 실제 위치지만,
// 원본이 모드 지연보다 이만큼 더 지났는데 0 이면 모르는 위치로 본다(버퍼 재개 지연은 1초 안팎이다).
const UNKNOWN_PLAYHEAD_MARGIN_MS = 5000;

function isUnknownPlayhead({ mode, playbackVideoTimeMs, liveVideoTimeMs }) {
  const delayMs = MODE_DELAY_MS_MAP[mode];
  return playbackVideoTimeMs <= 0 && Number.isFinite(delayMs) && liveVideoTimeMs > delayMs + UNKNOWN_PLAYHEAD_MARGIN_MS;
}

// 해설이 들리기 시작한 순간 사용자가 듣던 소리가 캡처된 벽시계 시각. 교차 모드는 지연 재생만큼 앞이다.
// 지연 재생 위치를 모르면 null 이다.
function resolvePlayedWallMs(playback) {
  if (Number.isFinite(playback.playbackVideoTimeMs) && Number.isFinite(playback.liveVideoTimeMs)) {
    if (isUnknownPlayhead(playback)) return null;
    return playback.wallMs - (playback.liveVideoTimeMs - playback.playbackVideoTimeMs);
  }
  return playback.wallMs;
}

module.exports = { resolveCaptureStartWallMs, resolvePlayedWallMs };
