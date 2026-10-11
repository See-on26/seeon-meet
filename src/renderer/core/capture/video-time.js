// 캡처 세션의 영상 시각(captureSource.videoTimeMs)과 벽시계(Date.now)를 오간다.
// ASR 청크 시각은 벽시계, 지연 재생·틈 후보는 영상 시각 축을 쓴다.
export function wallToVideoTimeMs({ wallTs, nowWallTs = Date.now(), nowVideoTimeMs }) {
  if (!Number.isFinite(wallTs) || !Number.isFinite(nowVideoTimeMs)) return null;
  return Math.max(0, nowVideoTimeMs - (nowWallTs - wallTs));
}

export function clampToChunk({ wallTs, chunkStartTs, chunkEndTs }) {
  let clamped = wallTs;
  if (Number.isFinite(chunkStartTs)) clamped = Math.max(clamped, chunkStartTs);
  if (Number.isFinite(chunkEndTs)) clamped = Math.min(clamped, chunkEndTs);
  return clamped;
}

// 트리거가 든 세그먼트가 끝난 벽시계 시각. 트리거를 못 찾으면 마지막 세그먼트,
// 세그먼트 시각이 없으면 청크 끝으로 대신한다. ASR 타임스탬프가 청크 밖으로 넘치면 청크 안으로 자른다.
export function resolveSpeechEndWallTs({ chunkStartTs, chunkEndTs, segmentList = [], trigger = '' }) {
  const timedList = segmentList.filter((segment) => Number.isFinite(segment?.endSec));
  const triggerSegment = trigger
    ? timedList.find((segment) => String(segment.text || '').includes(trigger)) : null;
  const segment = triggerSegment || timedList[timedList.length - 1];
  if (segment && Number.isFinite(chunkStartTs)) {
    return clampToChunk({ wallTs: chunkStartTs + segment.endSec * 1000, chunkStartTs, chunkEndTs });
  }
  return Number.isFinite(chunkEndTs) ? chunkEndTs : null;
}

// 후보 구마다 그 말을 끝낸 영상 시각을 붙인다. 판단 전 보류·look-ahead 중에 합쳐진 뒤 조각의 후보가
// 공백(O) 판정을 받으면 결정의 첫 후보 시각이 아니라 이 시각 뒤에 해설을 넣기 위해서다.
export function attachCandidateEventVideoTime({ candidateList = [], chunkStartTs, chunkEndTs, segmentList = [],
  nowWallTs = Date.now(), nowVideoTimeMs }) {
  return candidateList.map((candidate) => {
    if (!candidate?.phrase) return candidate;
    const wallTs = resolveSpeechEndWallTs({ chunkStartTs, chunkEndTs, segmentList, trigger: candidate.phrase });
    return { ...candidate, eventVideoTimeMs: wallToVideoTimeMs({ wallTs, nowWallTs, nowVideoTimeMs }) };
  });
}
