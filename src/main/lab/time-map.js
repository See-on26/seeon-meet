// 들린 순간·캡처 시작 벽시계 계산은 제품 개발자 흐름 창과 같은 공용 모듈을 쓰고, 여기서 함께 내보낸다.
const { resolveCaptureStartWallMs, resolvePlayedWallMs } = require('../dev-flow/played-time');

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

module.exports = {
  buildTimeMap, wallToMediaMs, resolveCaptureStartWallMs, resolvePlayedWallMs,
};
