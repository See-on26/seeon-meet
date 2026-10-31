const SILENCE_MIN_INTERVAL_MS = 60000;

const SILENCE_GATE_REASON_MAP = {
  inFlight: 'in_flight',
  slideDone: 'slide_done',
  minuteCap: 'minute_cap',
};

const SILENCE_GATE_LABEL_MAP = {
  [SILENCE_GATE_REASON_MAP.inFlight]: '이전 무발화 처리 중',
  [SILENCE_GATE_REASON_MAP.slideDone]: '이 슬라이드에서 이미 무발화 해설을 냄',
  [SILENCE_GATE_REASON_MAP.minuteCap]: '분당 1회 상한',
};

// 무발화 해설은 슬라이드당 1회, 분당 1회만 낸다. 판정·묘사에 몇 초가 걸리므로 한 번에 하나만 처리한다.
// 허가할 때 표(ticket)를 주고 같은 표로만 반납받는다. 세션을 초기화한 뒤 늦게 끝난 요청이 새 세션 상태를 바꾸지 않게 하기 위해서다.
function createSilenceNarrationGate({ minIntervalMs = SILENCE_MIN_INTERVAL_MS, now = Date.now } = {}) {
  // 슬라이드별로 무발화 해설을 낸 시각. 분당 1회 상한은 이 중 가장 늦은 시각으로 잰다.
  const emittedAtBySlideMap = new Map();
  let lastEmittedAt = -Infinity;
  let activeTicket = null;
  let ticketSeq = 0;

  function deny(reason) {
    return { isAllowed: false, reason, ticket: null };
  }

  function tryAcquire({ slideLabel }) {
    if (activeTicket !== null) return deny(SILENCE_GATE_REASON_MAP.inFlight);
    if (emittedAtBySlideMap.has(String(slideLabel))) return deny(SILENCE_GATE_REASON_MAP.slideDone);
    if (now() - lastEmittedAt < minIntervalMs) return deny(SILENCE_GATE_REASON_MAP.minuteCap);
    ticketSeq += 1;
    activeTicket = ticketSeq;
    return { isAllowed: true, reason: null, ticket: activeTicket };
  }

  function release({ ticket, slideLabel, isEmitted }) {
    if (ticket === null || ticket !== activeTicket) return;
    activeTicket = null;
    if (!isEmitted) return;
    lastEmittedAt = now();
    emittedAtBySlideMap.set(String(slideLabel), lastEmittedAt);
  }

  // 내보낸 무발화 해설을 사용자가 듣지 못했으면(재생 전에 버려짐) 그 슬라이드의 기록을 지워 다시 낼 수 있게 한다.
  function revert({ slideLabel }) {
    const isReverted = emittedAtBySlideMap.delete(String(slideLabel));
    if (isReverted) lastEmittedAt = Math.max(-Infinity, ...emittedAtBySlideMap.values());
    return isReverted;
  }

  function reset() {
    emittedAtBySlideMap.clear();
    lastEmittedAt = -Infinity;
    activeTicket = null;
  }

  return { tryAcquire, release, revert, reset };
}

module.exports = {
  createSilenceNarrationGate, SILENCE_GATE_REASON_MAP, SILENCE_GATE_LABEL_MAP, SILENCE_MIN_INTERVAL_MS,
};
