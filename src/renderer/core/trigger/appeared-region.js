// 발표자가 그림·글을 붙여 넣거나 끌어다 놓으면 바뀐 곳이 화면의 10% 를 넘어 가리킴 영역(상한 10%)으로 잡히지 않는다.
// 그러면 지시 해설은 긴 변 1280 전체 화면 한 장에서 그림 속 작은 상품명·로고를 읽어야 해 이름을 빠뜨리거나 비슷한 말을 지어낸다.
// 직전 정지 화면과 견줘 화면의 10~50% 를 덮는 바뀐 칸 상자를 "방금 나타난 그림" 영역으로 잠시 기억했다가,
// 가리킴이 없는 지시 발화에 붙인다. 그러면 지시 판정 화면이 그 영역을 원본 해상도로 잘라 [전체, 확대] 두 장으로 간다.
import { convertToGrayscale } from './ssim.js';
import { computeChangeRegion, computeChangedCellMask } from './pointing-locator.js';
import { keepLargeComponents } from './screen-change-detector.js';
import { MAX_POINTING_CHANGED_RATIO } from './pointing-motion-tracker.js';

// 지시 영역의 종류. main 의 확대 종류(ZOOM_KIND_MAP.appeared)와 같은 값이다.
export const APPEARED_REGION_KIND = 'appeared';
// 이보다 작은 변화는 가리킴 몫이고, 절반을 넘으면 슬라이드 전체가 바뀐 것이다.
export const APPEARANCE_MIN_AREA_RATIO = MAX_POINTING_CHANGED_RATIO;
export const APPEARANCE_MAX_AREA_RATIO = 0.5;
// 트리거가 든 전사 구간 끝에서 이만큼 앞까지 나타난 그림을 그 발화가 가리킨 것으로 본다.
export const APPEARANCE_RECALL_WINDOW_MS = 5000;
// 직전 정지 화면이 이보다 오래전에 사라졌으면 견주지 않는다. 오래전 변화를 방금 나타난 것으로 보지 않게 한다.
export const SETTLED_BASE_MAX_AGE_MS = 15000;

export const DEIXIS_REGION_SOURCE_MAP = {
  pointing: 'pointing',
  recalledPointing: 'recalled_pointing',
  appeared: 'appeared',
  none: 'none',
};

// 가리킴 표본기·화면 변화 감지기와 같은 32×18 격자라 늘 변하는 칸 표를 그대로 받는다.
const GRID_ROW_COUNT = 18;
const GRID_COL_COUNT = 32;
// 정지 화면과의 누적 차이는 화면 변화 감지기와 같은 문턱(8), 앞 표본과의 차이는 가리킴 표본기와 같은 문턱(4)으로 본다.
const BASE_CELL_CHANGE_THRESHOLD = 8;
const STILL_CELL_CHANGE_THRESHOLD = 4;
// 480×270 표본에서 커서는 1~2칸이다. 이웃한 바뀐 칸 덩어리가 이보다 작으면 바뀐 것으로 세지 않는다(화면 변화 감지기와 같은 값).
const MIN_COMPONENT_CELL_COUNT = 3;
// 앞 표본과 같은 표본이 이만큼 이어지면 정지 화면이다(400ms 표본이면 0.8초).
const SETTLE_SAMPLE_COUNT = 2;
const SETTLED_KEEP_COUNT = 3;

const APPEARANCE_STATUS_MAP = { none: 'none', tooSmall: 'too_small', tooLarge: 'too_large', found: 'found' };

const isSameSize = (left, right) => left.width === right.width && left.height === right.height;

// 커서 같은 작은 덩어리와 늘 변하는 칸(웹캠·재생 영상)을 뺀 바뀐 칸 표.
function findSignificantCellMask({ grayA, grayB, width, height, cellChangeThreshold, excludedCellMask }) {
  const changedCellMask = computeChangedCellMask({
    grayA, grayB, width, height, rowCount: GRID_ROW_COUNT, colCount: GRID_COL_COUNT, cellChangeThreshold,
  });
  if (excludedCellMask) changedCellMask.forEach((_, index) => { if (excludedCellMask[index]) changedCellMask[index] = 0; });
  return keepLargeComponents({
    mask: changedCellMask, rowCount: GRID_ROW_COUNT, colCount: GRID_COL_COUNT, minCellCount: MIN_COMPONENT_CELL_COUNT,
  });
}

function measureAppearance({ baseGray, currentGray, width, height, excludedCellMask = null }) {
  const significantCellMask = findSignificantCellMask({
    grayA: baseGray, grayB: currentGray, width, height, cellChangeThreshold: BASE_CELL_CHANGE_THRESHOLD, excludedCellMask,
  });
  const verdict = computeChangeRegion({
    grayA: baseGray, grayB: currentGray, width, height, rowCount: GRID_ROW_COUNT, colCount: GRID_COL_COUNT,
    cellChangeThreshold: BASE_CELL_CHANGE_THRESHOLD, maxChangedRatio: APPEARANCE_MAX_AREA_RATIO,
    excludedCellMask: significantCellMask.map((isSignificant) => (isSignificant ? 0 : 1)),
  });
  if (!verdict.hasRegion) {
    return { status: verdict.changedRatio > 0 ? APPEARANCE_STATUS_MAP.tooLarge : APPEARANCE_STATUS_MAP.none, rect: null };
  }
  const areaRatio = verdict.rect.w * verdict.rect.h;
  if (areaRatio < APPEARANCE_MIN_AREA_RATIO) return { status: APPEARANCE_STATUS_MAP.tooSmall, rect: null };
  if (areaRatio > APPEARANCE_MAX_AREA_RATIO) return { status: APPEARANCE_STATUS_MAP.tooLarge, rect: null };
  return { status: APPEARANCE_STATUS_MAP.found, rect: verdict.rect };
}

// 정지 화면(base)과 지금 화면 사이 바뀐 칸 상자가 화면의 10~50% 이면 그 상자(0~1 비율), 아니면 null.
export function findAppearanceRect({ baseGray, currentGray, width, height, excludedCellMask = null }) {
  return measureAppearance({ baseGray, currentGray, width, height, excludedCellMask }).rect;
}

// 표본마다 직전 정지 화면을 따라가다가, 전환 후보 판정·같은 슬라이드 화면 변화 때(capture) 나타난 그림 영역을 기억한다.
export function createAppearanceTracker({
  recallWindowMs = APPEARANCE_RECALL_WINDOW_MS, baseMaxAgeMs = SETTLED_BASE_MAX_AGE_MS,
} = {}) {
  let latest = null;
  let stillCount = 0;
  // 오래된 것부터. 같은 화면이 머무는 동안은 마지막 항목의 그림과 마지막 본 시각만 고친다.
  let settledList = [];
  let appearance = null;

  function recordSettled(frame) {
    const newest = settledList[settledList.length - 1];
    const isSameAsNewest = newest && isSameSize(newest, frame) && measureAppearance({
      baseGray: newest.gray, currentGray: frame.gray, width: frame.width, height: frame.height,
      excludedCellMask: frame.excludedCellMask,
    }).status === APPEARANCE_STATUS_MAP.none;
    const entry = { gray: frame.gray, width: frame.width, height: frame.height, lastSeenTs: frame.ts };
    settledList = isSameAsNewest
      ? [...settledList.slice(0, -1), entry]
      : [...settledList, entry].slice(-SETTLED_KEEP_COUNT);
  }

  function sample({ imageData, ts, excludedCellMask = null }) {
    const frame = { gray: convertToGrayscale(imageData), width: imageData.width, height: imageData.height, ts, excludedCellMask };
    const isStill = Boolean(latest) && isSameSize(latest, frame) && !findSignificantCellMask({
      grayA: latest.gray, grayB: frame.gray, width: frame.width, height: frame.height,
      cellChangeThreshold: STILL_CELL_CHANGE_THRESHOLD, excludedCellMask,
    }).some(Boolean);
    stillCount = isStill ? stillCount + 1 : 0;
    latest = frame;
    if (stillCount >= SETTLE_SAMPLE_COUNT) recordSettled(frame);
  }

  // 지금 화면과 다른 가장 최근 정지 화면과 견준다. 그 변화가 작으면(가리킴 몫) 거기서 멈추고, 너무 크면 그 앞 정지 화면과
  // 다시 견준다 — 붙여 넣은 자리에서 잠시 멈췄다 끌어 옮기면 두 자리를 묶은 상자가 커지기 때문이다.
  function capture({ slideLabel = null, wallTs, nowTs }) {
    if (!latest || !Number.isFinite(wallTs)) return null;
    const baseList = settledList
      .filter((entry) => isSameSize(entry, latest) && nowTs - entry.lastSeenTs <= baseMaxAgeMs)
      .reverse();
    for (const base of baseList) {
      const { status, rect } = measureAppearance({
        baseGray: base.gray, currentGray: latest.gray, width: latest.width, height: latest.height,
        excludedCellMask: latest.excludedCellMask,
      });
      if (status === APPEARANCE_STATUS_MAP.found) {
        appearance = { rect, wallTs, slideLabel };
        return rect;
      }
      if (status === APPEARANCE_STATUS_MAP.tooSmall) return null;
    }
    return null;
  }

  // eventWallTs: 트리거가 든 전사 구간이 끝난 벽시계 시각. 발화가 끝난 뒤 전사가 오기 전에 나타난 그림도 붙인다.
  function recall({ eventWallTs, slideLabel = null }) {
    if (!appearance || !Number.isFinite(eventWallTs)) return null;
    if (appearance.slideLabel !== slideLabel || appearance.wallTs < eventWallTs - recallWindowMs) return null;
    return { ...appearance.rect, kind: APPEARED_REGION_KIND };
  }

  function reset() {
    latest = null;
    stillCount = 0;
    settledList = [];
    appearance = null;
  }

  return { sample, capture, recall, reset };
}

// 지시 발화에 붙일 영역: 직전 창의 가리킴 → 발화 전 움직이며 가리킨 기억 → 방금 나타난 그림 → 없음(전체 화면).
export function pickDeixisRegion({ sequence, recalledPointing = null, appearedRegion = null }) {
  if (sequence?.region) return { ...sequence, source: DEIXIS_REGION_SOURCE_MAP.pointing };
  if (recalledPointing) return { ...recalledPointing, source: DEIXIS_REGION_SOURCE_MAP.recalledPointing };
  if (appearedRegion) return { region: appearedRegion, pointingOrderHint: '', source: DEIXIS_REGION_SOURCE_MAP.appeared };
  return { region: null, pointingOrderHint: '', source: DEIXIS_REGION_SOURCE_MAP.none };
}
