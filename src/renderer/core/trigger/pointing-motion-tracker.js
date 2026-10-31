// 가리킴 움직임은 화면 캡처·압축 잡음에서도 잡힌다(같은 자리에서 같은 세기로 반복, 이웃한 두 자리 오감).
// 펜·레이저 점은 대상 주위를 움직여 최근 몇 초 동안 영역 중심이 여러 칸을 지난다. 이렇게 움직일 때만 가리킴으로 기억한다.
// 화면이 한꺼번에 크게 바뀐 표본(슬라이드 전환)은 자리로 세지 않는다.
export const MOTION_WINDOW_MS = 2000;
export const MIN_MOVING_PLACE_COUNT = 3;
export const MAX_POINTING_CHANGED_RATIO = 0.1;

// 자리는 가리킴 탐지 격자(32×18)와 같은 칸 단위로 센다.
const PLACE_COL_COUNT = 32;
const PLACE_ROW_COUNT = 18;

function toPlaceKey(rect) {
  const col = Math.round((rect.x + rect.w / 2) * PLACE_COL_COUNT);
  const row = Math.round((rect.y + rect.h / 2) * PLACE_ROW_COUNT);
  return `${col}:${row}`;
}

export function createPointingMotionTracker({
  windowMs = MOTION_WINDOW_MS, minPlaceCount = MIN_MOVING_PLACE_COUNT, maxChangedRatio = MAX_POINTING_CHANGED_RATIO,
} = {}) {
  let sampleList = [];

  function add({ ts, rect, changedRatio = 0 }) {
    if (!rect || !Number.isFinite(ts) || changedRatio > maxChangedRatio) return;
    sampleList = [...sampleList.filter((sample) => ts - sample.ts <= windowMs), { ts, placeKey: toPlaceKey(rect) }];
  }

  function isMoving({ nowTs }) {
    const recentList = sampleList.filter((sample) => sample.ts <= nowTs && nowTs - sample.ts <= windowMs);
    return new Set(recentList.map((sample) => sample.placeKey)).size >= minPlaceCount;
  }

  return { add, isMoving, reset: () => { sampleList = []; } };
}
