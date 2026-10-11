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

// 전사 글에서 세그먼트마다 차지하는 글자 범위를 앞에서부터 찾는다(전사 글은 세그먼트 글을 이어 붙인 것이다).
function locateSegmentRangeList({ text, segmentList }) {
  let cursor = 0;
  return segmentList.map((segment) => {
    const segmentText = String(segment?.text || '').trim();
    const index = segmentText ? text.indexOf(segmentText, cursor) : -1;
    if (index < 0) return null;
    cursor = index + segmentText.length;
    return { segment, start: index, end: cursor };
  });
}

// 후보의 글자 위치(start)로 세그먼트를 고른다. 같은 구가 한 조각에 두 번 나오거나 짧은 구가 앞 낱말 안에서
// 먼저 걸려도 실제 자리의 세그먼트를 쓰기 위해서다. 위치를 모르면 구가 든 첫 세그먼트로 찾는다.
function resolveCandidateEndWallTs({ candidate, text, chunkStartTs, chunkEndTs, segmentList }) {
  if (text && Number.isFinite(candidate.start) && Number.isFinite(chunkStartTs)) {
    const range = locateSegmentRangeList({ text, segmentList })
      .find((entry) => entry && candidate.start >= entry.start && candidate.start < entry.end);
    if (range && Number.isFinite(range.segment.endSec)) {
      return clampToChunk({ wallTs: chunkStartTs + range.segment.endSec * 1000, chunkStartTs, chunkEndTs });
    }
  }
  return resolveSpeechEndWallTs({ chunkStartTs, chunkEndTs, segmentList, trigger: candidate.phrase });
}

// 후보 구마다 그 말을 끝낸 영상 시각을 붙인다. look-ahead·판단 전 보류 중에 합쳐진 뒤 조각의 후보가
// 해설로 이어지면 결정의 첫 후보 시각이 아니라 그 말 뒤에 해설을 넣기 위해서다.
export function attachCandidateEventVideoTime({ candidateList = [], text = '', chunkStartTs, chunkEndTs, segmentList = [],
  nowWallTs = Date.now(), nowVideoTimeMs }) {
  return candidateList.map((candidate) => {
    if (!candidate?.phrase) return candidate;
    const wallTs = resolveCandidateEndWallTs({ candidate, text, chunkStartTs, chunkEndTs, segmentList });
    return { ...candidate, eventVideoTimeMs: wallToVideoTimeMs({ wallTs, nowWallTs, nowVideoTimeMs }) };
  });
}
