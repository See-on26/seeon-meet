// 캡처 세션의 영상 시각(captureSource.videoTimeMs)과 벽시계(Date.now)를 오간다.
// ASR 청크 시각은 벽시계, 지연 재생·틈 후보는 영상 시각 축을 쓴다.
export function wallToVideoTimeMs({ wallTs, nowWallTs = Date.now(), nowVideoTimeMs }) {
  if (!Number.isFinite(wallTs) || !Number.isFinite(nowVideoTimeMs)) return null;
  return Math.max(0, nowVideoTimeMs - (nowWallTs - wallTs));
}

// 트리거가 든 발화가 끝난 벽시계 시각. 세그먼트 시각이 없으면 청크 끝으로 대신한다.
export function resolveSpeechEndWallTs({ chunkStartTs, chunkEndTs, segmentList = [] }) {
  const lastSegment = segmentList[segmentList.length - 1];
  if (lastSegment && Number.isFinite(lastSegment.endSec) && Number.isFinite(chunkStartTs)) {
    return chunkStartTs + lastSegment.endSec * 1000;
  }
  return Number.isFinite(chunkEndTs) ? chunkEndTs : null;
}
