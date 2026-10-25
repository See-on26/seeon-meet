const { listLiveVisit } = require('./cancelled-transition');

// 회의 요약의 구간. 슬라이드 방문 하나가 구간 하나이고, 화면이 없던 시간과 오래 머문 방문은 시간으로 끊는다.
// 스냅숏만으로 계산하므로 회의 중에 몇 번을 다시 계산해도 이미 닫힌 구간의 key 는 그대로다.
const DEFAULT_MAX_SEGMENT_MS = 300000;
// 이보다 짧은 구간은 화면을 스쳐 지나간 것이라 따로 요약하지 않는다.
const DEFAULT_MIN_SEGMENT_MS = 5000;

function toSegmentKey({ slideMajor, startTs }) {
  return `${slideMajor ?? 'none'}@${startTs}`;
}

// 취소된 방문만 사이에 둔 같은 슬라이드의 방문은 화면이 바뀐 적이 없으므로 한 방문으로 잇는다.
// 사이에 살아 있는 방문이 하나라도 있으면(5초 미만이라 구간이 아니어도) 따로 둔다.
function mergeAcrossCancelledVisit({ visitList, liveStartTsList }) {
  const mergedList = [];
  for (const visit of visitList) {
    const previous = mergedList.at(-1);
    const isOnlyCancelledBetween = Boolean(previous) && Number.isFinite(previous.endTs)
      && !liveStartTsList.some((startTs) => startTs >= previous.endTs && startTs < visit.startTs);
    if (isOnlyCancelledBetween) previous.endTs = visit.endTs;
    else mergedList.push({ startTs: visit.startTs, endTs: visit.endTs });
  }
  return mergedList;
}

// 취소된 전환의 방문을 뺀 살아 있는 방문. 같은 슬라이드의 둘째 이후 방문은 다시 온 방문이다.
function listLiveVisitSpan({ snapshot }) {
  const cancelledList = snapshot.cancelledTransitionList || [];
  const liveVisitBySlideList = (snapshot.slideList || [])
    .map((slide) => ({ slide, visitList: listLiveVisit({ slide, cancelledList }) }));
  const liveStartTsList = liveVisitBySlideList.flatMap(({ visitList }) => visitList.map((visit) => visit.startTs));
  return liveVisitBySlideList.flatMap(({ slide, visitList }) => mergeAcrossCancelledVisit({ visitList, liveStartTsList })
    .map((visit, index) => ({
      slideMajor: slide.major, startTs: visit.startTs,
      endTs: Number.isFinite(visit.endTs) ? visit.endTs : null, isRevisit: index > 0,
    })));
}

// 첫 방문 전에 오간 말은 화면 없는 구간으로 담는다. 시작 시각이 고정이라 늦게 도착한 발화가 key 를 바꾸지 않는다.
function buildBeforeFirstVisitSpan({ snapshot, firstVisitStartTs }) {
  const { startedAt } = snapshot;
  if (!Number.isFinite(startedAt) || startedAt >= firstVisitStartTs) return null;
  const hasUtterance = (snapshot.utteranceList || [])
    .some((utterance) => utterance.ts >= startedAt && utterance.ts < firstVisitStartTs);
  return hasUtterance ? { slideMajor: null, startTs: startedAt, endTs: firstVisitStartTs, isRevisit: false } : null;
}

function listSpan({ snapshot }) {
  const visitSpanList = listLiveVisitSpan({ snapshot });
  if (!visitSpanList.length) {
    if (!Number.isFinite(snapshot.startedAt)) return [];
    return [{ slideMajor: null, startTs: snapshot.startedAt, endTs: null, isRevisit: false }];
  }
  const firstVisitStartTs = Math.min(...visitSpanList.map((span) => span.startTs));
  const beforeSpan = buildBeforeFirstVisitSpan({ snapshot, firstVisitStartTs });
  return beforeSpan ? [beforeSpan, ...visitSpanList] : visitSpanList;
}

// 경계를 방문 시작에 묶어 두므로, 열린 방문을 더 늦은 시각으로 닫아 다시 계산해도 앞 조각은 똑같이 나온다.
function splitSpan({ span, endTs, isOpen, maxSegmentMs }) {
  const segmentList = [];
  for (let pieceStartTs = span.startTs; pieceStartTs < endTs; pieceStartTs += maxSegmentMs) {
    const pieceEndTs = Math.min(pieceStartTs + maxSegmentMs, endTs);
    segmentList.push({
      key: toSegmentKey({ slideMajor: span.slideMajor, startTs: pieceStartTs }),
      slideMajor: span.slideMajor, startTs: pieceStartTs, endTs: pieceEndTs,
      isRevisit: span.isRevisit, isOpenTail: isOpen && pieceEndTs === endTs,
    });
  }
  return segmentList;
}

// 끝 시각이 없는 방문(지금 보고 있는 화면)은 endTs 가 주어졌을 때만 그 시각에 닫고, 그 마지막 조각을 isOpenTail 로 표시한다.
function listSegments({
  snapshot, endTs = null, maxSegmentMs = DEFAULT_MAX_SEGMENT_MS, minSegmentMs = DEFAULT_MIN_SEGMENT_MS,
}) {
  if (!(maxSegmentMs > 0)) throw new RangeError(`maxSegmentMs 는 0보다 커야 한다: ${maxSegmentMs}`);
  const isEndKnown = Number.isFinite(endTs);
  return listSpan({ snapshot })
    .flatMap((span) => {
      const isOpen = span.endTs === null;
      if (isOpen && !isEndKnown) return [];
      return splitSpan({ span, endTs: isOpen ? endTs : span.endTs, isOpen, maxSegmentMs });
    })
    .filter((segment) => segment.endTs - segment.startTs >= minSegmentMs)
    .sort((left, right) => left.startTs - right.startTs);
}

module.exports = { listSegments, DEFAULT_MAX_SEGMENT_MS };
