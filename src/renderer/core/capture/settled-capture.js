// Meet 화면 크기가 바뀐 직후에는 공유 화면 좌표가 새 크기에서 자리 잡을 때까지(약 1~2초) 화면을 자르지 않는다.
// 사용자가 묻거나 발표자가 가리킨 순간의 화면을 "캡처 실패"로 버리지 않도록, 자리 잡을 때까지 잠깐 기다렸다가 찍는다.
// 상한이 지나도 자리 잡지 않으면 더 기다리지 않고 지금 찍어 본다(그래도 자를 수 없으면 null).
export const SETTLED_CAPTURE_WAIT_MS = 2000;
export const SETTLED_CAPTURE_POLL_MS = 100;

function waitMs(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export async function captureWhenSettled({
  isSettling, capture, maxWaitMs = SETTLED_CAPTURE_WAIT_MS, pollMs = SETTLED_CAPTURE_POLL_MS,
  now = () => Date.now(), wait = waitMs,
}) {
  const startedAt = now();
  while (isSettling()) {
    const remainingMs = maxWaitMs - (now() - startedAt);
    if (remainingMs <= 0) break;
    await wait(Math.min(pollMs, remainingMs));
  }
  return capture();
}
