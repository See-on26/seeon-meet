const ROI_RELAY_MIN_INTERVAL_MS = 250;

// Meet 좌표를 뷰어로 넘기되 250ms 에 한 번보다 자주 보내지 않는다. 간격 안에 들어온 좌표는 다음 좌표를 기다리지 않고
// 간격이 끝나면 마지막 것을 보낸다. Meet 쪽은 500ms 마다 보내므로, 기다리면 창 크기를 바꾼 직후 다시 잰 좌표가 최대 0.5초 늦는다.
function createRoiRelay({
  send, minIntervalMs = ROI_RELAY_MIN_INTERVAL_MS, now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => clearTimeout(handle),
}) {
  let lastSentAt = -Infinity;
  let pendingPayload = null;
  let flushTimer = null;

  function cancelFlushTimer() {
    if (flushTimer === null) return;
    clearTimer(flushTimer);
    flushTimer = null;
  }

  function flushPending({ nowMs }) {
    cancelFlushTimer();
    const payload = pendingPayload;
    pendingPayload = null;
    lastSentAt = nowMs;
    try {
      send(payload);
    } catch (error) {
      console.warn(`[roi-relay] 송신 실패(무시): ${error.message}`);
    }
  }

  return {
    push({ payload }) {
      pendingPayload = payload;
      const nowMs = now();
      const remainingMs = minIntervalMs - (nowMs - lastSentAt);
      if (remainingMs <= 0) {
        flushPending({ nowMs });
        return;
      }
      if (flushTimer !== null) return;
      flushTimer = setTimer(() => {
        flushTimer = null;
        if (pendingPayload) flushPending({ nowMs: now() });
      }, remainingMs);
    },
    reset() {
      cancelFlushTimer();
      lastSentAt = -Infinity;
      pendingPayload = null;
    },
  };
}

module.exports = { createRoiRelay, ROI_RELAY_MIN_INTERVAL_MS };
