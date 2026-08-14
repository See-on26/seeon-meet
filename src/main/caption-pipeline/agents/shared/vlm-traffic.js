const DEFAULT_QUIET_MS = 300;
const DEFAULT_MAX_WAIT_MS = 60000;

// GPU 서버 하나를 실시간 해설(전경)과 요약 같은 긴 글 요청(배경)이 함께 쓴다.
// 배경은 진행 중인 전경이 없고 마지막 전경이 끝난 지 quietMs 가 지났을 때 보내 해설이 늦어지지 않게 한다.
// 해설이 끊이지 않아도 배경이 한없이 밀리지 않게 maxWaitMs 를 기다리면 그냥 보낸다. 전경은 배경을 기다리지 않는다.
function createVlmTraffic({ quietMs = DEFAULT_QUIET_MS, maxWaitMs = DEFAULT_MAX_WAIT_MS, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let foregroundInFlight = 0;
  let lastForegroundEndAt = -Infinity;

  async function runForeground(task) {
    foregroundInFlight += 1;
    try {
      return await task();
    } finally {
      foregroundInFlight -= 1;
      lastForegroundEndAt = now();
    }
  }

  // 전경이 도는 동안은 quietMs 마다 다시 보고, 끝난 뒤에는 조용한 시간이 quietMs 를 채울 때까지만 잔다.
  async function waitForQuiet() {
    const waitStartAt = now();
    for (;;) {
      const remainingMs = maxWaitMs - (now() - waitStartAt);
      if (remainingMs <= 0) return;
      const isForegroundIdle = foregroundInFlight === 0;
      const quietForMs = now() - lastForegroundEndAt;
      if (isForegroundIdle && quietForMs >= quietMs) return;
      const waitMs = isForegroundIdle ? quietMs - quietForMs : quietMs;
      await sleep(Math.max(1, Math.min(waitMs, remainingMs)));
    }
  }

  async function runBackground(task) {
    await waitForQuiet();
    return task();
  }

  return { runForeground, runBackground, getForegroundInFlight: () => foregroundInFlight };
}

const defaultVlmTraffic = createVlmTraffic();

module.exports = { createVlmTraffic, defaultVlmTraffic };
