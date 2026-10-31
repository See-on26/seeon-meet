// 전환 감지기의 판정을 슬라이드 확정 요청으로 바꾼다.
// 화면 공유 영역이 바뀌면 감지기를 리셋하고 잠시(억제 구간) 확정하지 않는다. 리셋 뒤 첫 프레임에 붙는 "첫 장" 표시가
// 이 구간에 들어와 버려지면, 화면이 그대로인 동안에는 다음 전환까지 첫 장을 확정하지 못한다.
// 그래서 첫 장 표시는 기억해 두었다가 억제가 끝나고 다른 확정이 없을 때 지금 화면을 첫 장으로 확정한다.
export function createSlideCandidateGate() {
  let isFirstPending = false;

  function decide({ verdict, ts, suppressUntil, isConfirming }) {
    if (verdict.isFirst) isFirstPending = true;
    if (ts < suppressUntil || isConfirming) return { shouldConfirm: false, isFirst: false };
    if (verdict.isTransition) {
      isFirstPending = false;
      return { shouldConfirm: true, isFirst: false };
    }
    if (isFirstPending) {
      isFirstPending = false;
      return { shouldConfirm: true, isFirst: true };
    }
    return { shouldConfirm: false, isFirst: false };
  }

  function reset() {
    isFirstPending = false;
  }

  return { decide, reset };
}
