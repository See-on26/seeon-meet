import { GAP_INSERT_GUARD_MS } from './audio-gap-candidates.js';

// 성능 모드는 지연이 0.3초뿐이라 해설을 만들고 음성으로 바꾸는 사이에 재생이 고른 틈을 이미 지나간다.
// 그대로 멈추면 말 한가운데서 회의가 끊기므로, 회의를 멈추기 직전에 재생 위치가 잰 무음에 들어설 때까지 잠시 기다린다.
// 무음은 라이브 소리로 재고(SilenceSpanTracker), 재생 위치는 라이브보다 늦어 이미 잰 무음과 바로 비교할 수 있다.
export const INSERT_GAP_MAX_WAIT_MS = 1500;
const INSERT_GAP_POLL_MS = 50;
// 멈출 때 소리를 줄이는 동안(0.08초) 재생이 더 나가므로 무음 끝까지 그만큼은 남아 있어야 한다.
const INSERT_GAP_MIN_TAIL_MS = 100;

export function shouldWaitForInsertGap({ hasDelayBuffer, delayMs }) {
  return hasDelayBuffer && delayMs <= 0;
}

export function isPlayheadInSilence({ playheadMs, spanList, guardMs = GAP_INSERT_GUARD_MS, tailMs = INSERT_GAP_MIN_TAIL_MS }) {
  if (!Number.isFinite(playheadMs)) return false;
  return spanList.some((span) => playheadMs >= span.startMs + guardMs && playheadMs <= span.endMs - tailMs);
}

export async function waitForPlayheadSilence({ isInSilence, maxWaitMs = INSERT_GAP_MAX_WAIT_MS, pollMs = INSERT_GAP_POLL_MS,
  now = () => performance.now(), sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) }) {
  const startedAt = now();
  for (;;) {
    const waitedMs = now() - startedAt;
    if (isInSilence()) return { isSilence: true, waitedMs };
    if (waitedMs >= maxWaitMs) return { isSilence: false, waitedMs };
    await sleep(pollMs);
  }
}
