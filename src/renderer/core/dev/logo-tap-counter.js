// 개발자 모드 열기: 로고를 짧은 시간 안에 여러 번 누른 것을 센다. 최근 windowMs 안에 count 번 눌렀으면 참을 돌려주고 다시 센다.
export const LOGO_TAP_MAP = { count: 5, windowMs: 2000 };

export function createLogoTapCounter({ count = LOGO_TAP_MAP.count, windowMs = LOGO_TAP_MAP.windowMs, now = () => performance.now() } = {}) {
  let tapList = [];
  return {
    tap() {
      const nowMs = now();
      tapList = [...tapList.filter((tapMs) => nowMs - tapMs <= windowMs), nowMs];
      if (tapList.length < count) return false;
      tapList = [];
      return true;
    },
  };
}
