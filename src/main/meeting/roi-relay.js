const ROI_RELAY_MIN_INTERVAL_MS = 250;

function createRoiRelay({ send, minIntervalMs = ROI_RELAY_MIN_INTERVAL_MS, now = Date.now }) {
  let lastSentAt = -Infinity;
  let pendingPayload = null;

  function flushPending({ nowMs }) {
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
      if (nowMs - lastSentAt < minIntervalMs) return;
      flushPending({ nowMs });
    },
    reset() {
      lastSentAt = -Infinity;
      pendingPayload = null;
    },
  };
}

module.exports = { createRoiRelay, ROI_RELAY_MIN_INTERVAL_MS };
