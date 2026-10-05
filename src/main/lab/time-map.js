const { MODE_DELAY_MS_MAP } = require('./lab-mode');

// 재생 화면이 200ms 마다 보내는 시각 보고({ wallMs, mediaMs, paused, ended })로 벽시계 → 원본 영상 시각을 바꾼다.
// 일시정지·버퍼링으로 생기는 어긋남은 보고 표가 흡수한다.
function isUsableReport(report) {
  return Boolean(report) && Number.isFinite(report.wallMs) && Number.isFinite(report.mediaMs);
}

function buildTimeMap({ reportList }) {
  return reportList.filter(isUsableReport).sort((reportA, reportB) => reportA.wallMs - reportB.wallMs);
}

function findLastIndexAtOrBefore({ timeMap, wallMs }) {
  let low = 0;
  let high = timeMap.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (timeMap[middle].wallMs <= wallMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function wallToMediaMs({ timeMap, wallMs }) {
  if (!timeMap.length || !Number.isFinite(wallMs)) return null;
  const index = findLastIndexAtOrBefore({ timeMap, wallMs });
  if (index < 0) {
    const first = timeMap[0];
    if (first.paused || first.ended) return first.mediaMs;
    return Math.max(0, first.mediaMs - (first.wallMs - wallMs));
  }
  const before = timeMap[index];
  // 멈춘 동안(일시정지·끝남)은 위치가 그대로다.
  if (before.paused || before.ended) return before.mediaMs;
  const after = timeMap[index + 1];
  // 마지막 보고 뒤는 1배속으로 흐른다고 본다.
  if (!after) return before.mediaMs + (wallMs - before.wallMs);
  const spanMs = after.wallMs - before.wallMs;
  if (spanMs <= 0) return before.mediaMs;
  return before.mediaMs + ((after.mediaMs - before.mediaMs) * (wallMs - before.wallMs)) / spanMs;
}

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

module.exports = {
  buildTimeMap, wallToMediaMs, resolveCaptureStartWallMs, resolvePlayedWallMs,
};
