// 화면 변화 해설(같은 슬라이드 변화 해설과 늦은 근거 재시도)은 한 번에 하나만 처리하고 슬라이드당 상한까지만 낸다.
// 변화 해설끼리의 간격은 차단 규칙 표(blocking-policy)가 정한다. 허가할 때 표(ticket)를 주고 같은 표로만 반납받아,
// 세션을 초기화한 뒤 늦게 끝난 요청이 새 세션 상태를 바꾸지 않게 한다(무발화 게이트와 같은 꼴).
const DEFAULT_PER_SLIDE_MAX = 2;

const SCREEN_CHANGE_GATE_REASON_MAP = {
  inFlight: 'in_flight',
  slideCap: 'slide_cap',
  interval: 'interval',
};

function toSlideKey(slideLabel) {
  return String(slideLabel ?? '').split('-')[0];
}

function createScreenChangeGate({ perSlideMax = DEFAULT_PER_SLIDE_MAX } = {}) {
  const emittedCountBySlideMap = new Map();
  let activeTicket = null;
  let ticketSeq = 0;

  function countOf({ slideLabel }) {
    return emittedCountBySlideMap.get(toSlideKey(slideLabel)) || 0;
  }

  function tryAcquire({ slideLabel }) {
    if (activeTicket !== null) return { isAllowed: false, reason: SCREEN_CHANGE_GATE_REASON_MAP.inFlight, ticket: null };
    if (countOf({ slideLabel }) >= perSlideMax) {
      return { isAllowed: false, reason: SCREEN_CHANGE_GATE_REASON_MAP.slideCap, ticket: null };
    }
    ticketSeq += 1;
    activeTicket = ticketSeq;
    return { isAllowed: true, reason: null, ticket: activeTicket };
  }

  function release({ ticket, slideLabel, isEmitted }) {
    if (ticket === null || ticket !== activeTicket) return;
    activeTicket = null;
    if (isEmitted) emittedCountBySlideMap.set(toSlideKey(slideLabel), countOf({ slideLabel }) + 1);
  }

  // 낸 변화 해설을 사용자가 듣지 못했으면(재생 전에 버려짐) 그 슬라이드 횟수를 하나 되돌린다.
  function revert({ slideLabel }) {
    const count = countOf({ slideLabel });
    if (!count) return false;
    emittedCountBySlideMap.set(toSlideKey(slideLabel), count - 1);
    return true;
  }

  function reset() {
    emittedCountBySlideMap.clear();
    activeTicket = null;
  }

  return { tryAcquire, release, revert, reset, countOf };
}

module.exports = { createScreenChangeGate, SCREEN_CHANGE_GATE_REASON_MAP, DEFAULT_PER_SLIDE_MAX };
