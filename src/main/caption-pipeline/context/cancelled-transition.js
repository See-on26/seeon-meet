// 체류 3초를 못 채워 취소된 전환을 가려낸다. 회의 스크립트와 요약 구간이 같은 기준으로 그 전환 줄과 방문을 뺀다.
function isCancelledTransition({ transition, cancelledList }) {
  return cancelledList.some((cancelled) => cancelled.slideMajor === transition.slideMajor
    && cancelled.requestTs !== null && cancelled.requestTs === transition.ts);
}

function isFlashVisit({ slideMajor, visit, cancelledList }) {
  return cancelledList.some((cancelled) => cancelled.slideMajor === slideMajor
    && cancelled.transitionTs !== null && cancelled.transitionTs === visit.startTs);
}

function listLiveVisit({ slide, cancelledList }) {
  return (slide.visitList || [])
    .filter((visit) => !isFlashVisit({ slideMajor: slide.major, visit, cancelledList }));
}

module.exports = { isCancelledTransition, listLiveVisit };
