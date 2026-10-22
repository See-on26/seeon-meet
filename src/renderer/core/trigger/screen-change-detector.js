// 같은 슬라이드 안에서 화면 일부가 새로 나타나거나 바뀐 순간(값 표시·답 공개·팝업·툴팁)을 고른다.
// 400ms 표본(회색조)을 "마지막으로 받아들인 화면(기준)"과 칸 단위로 견준다. 바뀐 칸이 머물러 굳으면 사건 1건을 내고,
// 굳은 화면을 새 기준으로 삼는다. 해설할지는 main 이 정하므로 사건을 내면 기준은 늘 바뀐다.
// 오탐 거르기: 작은 덩어리(커서) · 늘 변하는 칸(웹캠·영상) · 굳지 않는 변화(재생 영상) · 스크롤 · 가리킴 움직임(펜·레이저).

// 가리킴 위치 표본기와 같은 32×18 격자라 그 표본기가 찾은 늘 변하는 칸 표를 그대로 받는다.
const DEFAULT_ROW_COUNT = 18;
const DEFAULT_COL_COUNT = 32;
// 기준 대비 누적 차이를 보므로 가리킴 표본기(앞 표본 대비, 4)보다 높게 두어 압축 잡음·서서히 바뀌는 배경을 막는다.
const CELL_CHANGE_THRESHOLD = 8;
// 앞 표본과 이 값 이하로만 다르면 그 칸은 멈춘 것으로 본다.
const SETTLE_DIFF_THRESHOLD = 4;
const SETTLE_SAMPLE_COUNT = 3;
// 마우스를 올렸다 바로 뗀 hover·깜빡임은 이 시간 안에 사라진다.
const MIN_DURATION_MS = 1600;
// 이 안에 굳지 않으면 재생 영상으로 보고 버린다.
const MAX_WAIT_MS = 6000;
// 이보다 크게 바뀌면 화면 전체가 바뀐 것이라 전환 판정(임베딩)의 몫이다.
const MAX_CHANGED_RATIO = 0.4;
// 480×270 표본에서 커서는 1~2칸이다. 이웃한 바뀐 칸을 묶은 덩어리가 이보다 작으면 버린다.
const MIN_COMPONENT_CELL_COUNT = 3;
// 굳은 뒤 이 안에 다른 칸이 더 바뀌면(글머리가 연달아 나타남) 한 사건으로 묶는다. 처음 굳은 뒤 최대 GROUP_MAX_MS 까지.
const GROUP_WINDOW_MS = 800;
const GROUP_MAX_MS = 4000;
// 새 슬라이드가 뜨며 이어지는 빌드 애니메이션은 사건이 아니다. 확정 뒤 이만큼 지난 화면을 기준으로 삼는다.
const SLIDE_START_QUIET_MS = 4000;
// 스크롤: 행(열) 평균 명도 윤곽을 밀어 맞춰 본다. 이동량 상한은 480×270 표본의 60px, 작은 표본은 길이의 1/4.
const SCROLL_MAX_SHIFT_PX = 60;
const SCROLL_MIN_SHIFT_PX = 3;
const SCROLL_RESIDUAL_RATIO = 0.4;
// 밀어 맞춘 기준 윤곽이 스스로 그만큼 달라져야(기준에 옮겨진 무늬가 있어야) 스크롤이다. 빈 바탕에 새 글이 뜬 경우를 거른다.
const SCROLL_SELF_SHIFT_RATIO = 0.5;
const SCROLL_MIN_PROFILE_DIFF = 1;

export const SCREEN_CHANGE_SKIP_REASON_MAP = {
  reverted: 'reverted',
  neverSettled: 'never_settled',
  tooLarge: 'too_large',
  pointing: 'pointing',
  tooSmall: 'too_small',
  scroll: 'scroll',
};

const NO_RESULT = Object.freeze({ event: null, skipReason: null, isBaselineCommitted: false, isSlideStart: false });

function computeCellBoundList({ length, count }) {
  return Array.from({ length: count + 1 }, (_, index) => Math.floor((index * length) / count));
}

// 칸마다 두 회색조 그림의 평균 절대 차이.
function computeCellDiffList({ grayA, grayB, width, rowBoundList, colBoundList }) {
  const rowCount = rowBoundList.length - 1;
  const colCount = colBoundList.length - 1;
  const diffList = new Float64Array(rowCount * colCount);
  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      let diffSum = 0;
      for (let y = rowBoundList[row]; y < rowBoundList[row + 1]; y += 1) {
        const rowOffset = y * width;
        for (let x = colBoundList[col]; x < colBoundList[col + 1]; x += 1) {
          diffSum += Math.abs(grayA[rowOffset + x] - grayB[rowOffset + x]);
        }
      }
      const pixelCount = (rowBoundList[row + 1] - rowBoundList[row]) * (colBoundList[col + 1] - colBoundList[col]) || 1;
      diffList[row * colCount + col] = diffSum / pixelCount;
    }
  }
  return diffList;
}

function countMask(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) count += mask[i];
  return count;
}

// 8방향으로 이웃한 칸을 한 덩어리로 묶고, MIN_COMPONENT_CELL_COUNT 칸 미만 덩어리는 뺀다.
function keepLargeComponents({ mask, rowCount, colCount, minCellCount }) {
  const kept = new Uint8Array(mask.length);
  const visited = new Uint8Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const component = [];
    const stack = [start];
    visited[start] = 1;
    while (stack.length) {
      const index = stack.pop();
      component.push(index);
      const row = Math.floor(index / colCount);
      const col = index % colCount;
      for (let dRow = -1; dRow <= 1; dRow += 1) {
        for (let dCol = -1; dCol <= 1; dCol += 1) {
          const nextRow = row + dRow;
          const nextCol = col + dCol;
          if (nextRow < 0 || nextRow >= rowCount || nextCol < 0 || nextCol >= colCount) continue;
          const next = nextRow * colCount + nextCol;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    if (component.length >= minCellCount) for (const index of component) kept[index] = 1;
  }
  return kept;
}

function toBoundingRect({ mask, rowCount, colCount }) {
  let minRow = Infinity; let minCol = Infinity; let maxRow = -1; let maxCol = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const row = Math.floor(index / colCount);
    const col = index % colCount;
    minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row);
    minCol = Math.min(minCol, col); maxCol = Math.max(maxCol, col);
  }
  if (maxRow < 0) return null;
  return {
    x: minCol / colCount, y: minRow / rowCount, w: (maxCol - minCol + 1) / colCount, h: (maxRow - minRow + 1) / rowCount,
  };
}

function computeProfile({ gray, width, height, axis }) {
  const isRow = axis === 'row';
  const length = isRow ? height : width;
  const span = isRow ? width : height;
  const profile = new Float64Array(length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) profile[isRow ? y : x] += gray[y * width + x];
  }
  for (let i = 0; i < length; i += 1) profile[i] /= span;
  return profile;
}

// 가운데 구간 [M, n−M) 의 평균 절대 차이. 모든 이동량을 같은 구간에서 견줘 가장자리로 밀려난 글이 차이를 줄이지 않게 한다.
function computeShiftResidual({ fixed, moved, shift, margin }) {
  let sum = 0;
  let count = 0;
  for (let i = margin; i < fixed.length - margin; i += 1) {
    sum += Math.abs(fixed[i] - moved[i + shift]);
    count += 1;
  }
  return count ? sum / count : 0;
}

function isProfileShifted({ baseProfile, currentProfile }) {
  const margin = Math.min(SCROLL_MAX_SHIFT_PX, Math.floor(baseProfile.length / 4));
  if (margin < SCROLL_MIN_SHIFT_PX) return false;
  const stillResidual = computeShiftResidual({ fixed: baseProfile, moved: currentProfile, shift: 0, margin });
  if (stillResidual < SCROLL_MIN_PROFILE_DIFF) return false;
  let bestShift = 0;
  let bestResidual = stillResidual;
  for (let shift = -margin; shift <= margin; shift += 1) {
    if (Math.abs(shift) < SCROLL_MIN_SHIFT_PX) continue;
    const residual = computeShiftResidual({ fixed: baseProfile, moved: currentProfile, shift, margin });
    if (residual < bestResidual) { bestResidual = residual; bestShift = shift; }
  }
  if (!bestShift || bestResidual > SCROLL_RESIDUAL_RATIO * stillResidual) return false;
  const selfShiftResidual = computeShiftResidual({ fixed: baseProfile, moved: baseProfile, shift: bestShift, margin });
  return selfShiftResidual >= SCROLL_SELF_SHIFT_RATIO * stillResidual;
}

export function isScrolled({ baseGray, currentGray, width, height }) {
  return ['row', 'col'].some((axis) => isProfileShifted({
    baseProfile: computeProfile({ gray: baseGray, width, height, axis }),
    currentProfile: computeProfile({ gray: currentGray, width, height, axis }),
  }));
}

export function createScreenChangeDetector({
  rowCount = DEFAULT_ROW_COUNT, colCount = DEFAULT_COL_COUNT,
} = {}) {
  const cellCount = rowCount * colCount;
  let baseline = null;
  let previous = null;
  let quietUntil = null;
  let pending = null;
  let boundCache = null;

  function readBoundList({ width, height }) {
    if (!boundCache || boundCache.width !== width || boundCache.height !== height) {
      boundCache = {
        width, height,
        rowBoundList: computeCellBoundList({ length: height, count: rowCount }),
        colBoundList: computeCellBoundList({ length: width, count: colCount }),
      };
    }
    return boundCache;
  }

  function adopt(frame) {
    baseline = frame;
    pending = null;
  }

  function finish({ frame, skipReason, isRebaselined }) {
    if (isRebaselined) adopt(frame);
    else pending = null;
    previous = frame;
    return { ...NO_RESULT, skipReason };
  }

  // 새 슬라이드(또는 재방문)로 확정되면 진행 중인 것을 버리고, 조용 구간이 끝난 화면을 기준으로 삼는다.
  // isSlideStart 가 아니고 그림을 주면 그 그림을 바로 기준으로 삼는다.
  function setBaseline({ ts, isSlideStart = true, gray = null, width = 0, height = 0 }) {
    pending = null;
    if (isSlideStart) {
      baseline = null;
      quietUntil = ts + SLIDE_START_QUIET_MS;
      return;
    }
    quietUntil = null;
    if (gray) baseline = { gray, width, height };
  }

  function reset() {
    baseline = null;
    previous = null;
    quietUntil = null;
    pending = null;
  }

  function buildEvent({ currentRawMask, ts }) {
    const finalMask = new Uint8Array(cellCount);
    for (let i = 0; i < cellCount; i += 1) finalMask[i] = pending.unionMask[i] & currentRawMask[i];
    const finalCount = countMask(finalMask);
    return {
      rect: toBoundingRect({ mask: finalMask, rowCount, colCount }),
      changedRatio: finalCount / cellCount,
      cellCount: finalCount,
      firstSeenTs: pending.startTs,
      firstSeenVideoTimeMs: pending.startVideoTimeMs,
      settledTs: pending.settledTs ?? ts,
    };
  }

  function startPending({ ts, videoTimeMs }) {
    return {
      startTs: ts, startVideoTimeMs: videoTimeMs, hasSignificant: false,
      unionMask: new Uint8Array(cellCount), stabilityMask: null, stableCount: 0,
      settledTs: null, firstSettledTs: null, hasPointing: false,
    };
  }

  function sample({ gray, width, height, ts, videoTimeMs = null, excludedCellMask = null,
    isPointingActive = false, isConfirming = false }) {
    const frame = { gray, width, height };
    if (baseline && (baseline.width !== width || baseline.height !== height)) baseline = null;
    if (quietUntil !== null) {
      previous = frame;
      if (ts < quietUntil) return NO_RESULT;
      quietUntil = null;
      adopt(frame);
      return { ...NO_RESULT, isBaselineCommitted: true, isSlideStart: true };
    }
    if (!baseline) {
      adopt(frame);
      previous = frame;
      return { ...NO_RESULT, isBaselineCommitted: true, isSlideStart: false };
    }

    const { rowBoundList, colBoundList } = readBoundList({ width, height });
    const baseDiffList = computeCellDiffList({ grayA: baseline.gray, grayB: gray, width, rowBoundList, colBoundList });
    const rawMask = new Uint8Array(cellCount);
    for (let i = 0; i < cellCount; i += 1) {
      if (baseDiffList[i] > CELL_CHANGE_THRESHOLD && !excludedCellMask?.[i]) rawMask[i] = 1;
    }
    const rawCount = countMask(rawMask);
    if (!rawCount) {
      if (!pending) { previous = frame; return NO_RESULT; }
      return finish({ frame, skipReason: SCREEN_CHANGE_SKIP_REASON_MAP.reverted, isRebaselined: false });
    }
    if (rawCount / cellCount > MAX_CHANGED_RATIO) {
      const isScroll = isScrolled({ baseGray: baseline.gray, currentGray: gray, width, height });
      return finish({
        frame, skipReason: isScroll ? SCREEN_CHANGE_SKIP_REASON_MAP.scroll : SCREEN_CHANGE_SKIP_REASON_MAP.tooLarge,
        isRebaselined: true,
      });
    }
    const significantMask = keepLargeComponents({ mask: rawMask, rowCount, colCount, minCellCount: MIN_COMPONENT_CELL_COUNT });
    const hasSignificant = countMask(significantMask) > 0;

    if (!pending) pending = startPending({ ts, videoTimeMs });
    // 의미 있는 덩어리가 사라지고 작은 칸만 남으면 그 변화는 되돌아간 것이다.
    if (pending.hasSignificant && !hasSignificant) {
      return finish({ frame, skipReason: SCREEN_CHANGE_SKIP_REASON_MAP.reverted, isRebaselined: false });
    }
    // 커서가 먼저 움직여 시작된 대기라도 의미 있는 덩어리가 처음 보인 때부터 잰다.
    if (hasSignificant && !pending.hasSignificant) {
      pending = { ...startPending({ ts, videoTimeMs }), hasPointing: pending.hasPointing };
      pending.hasSignificant = true;
    }
    if (isPointingActive) pending.hasPointing = true;
    const stabilityMask = hasSignificant ? significantMask : rawMask;
    for (let i = 0; i < cellCount; i += 1) pending.unionMask[i] |= significantMask[i];

    const frameDiffList = previous && previous.width === width && previous.height === height
      ? computeCellDiffList({ grayA: previous.gray, grayB: gray, width, rowBoundList, colBoundList }) : null;
    let isStable = Boolean(frameDiffList);
    if (frameDiffList) {
      for (let i = 0; i < cellCount; i += 1) {
        const isWatched = stabilityMask[i] || pending.stabilityMask?.[i];
        if (isWatched && frameDiffList[i] > SETTLE_DIFF_THRESHOLD) { isStable = false; break; }
      }
    }
    pending.stabilityMask = stabilityMask;
    previous = frame;
    pending.stableCount = isStable ? pending.stableCount + 1 : 0;

    const elapsedMs = ts - pending.startTs;
    const isSettled = pending.stableCount >= SETTLE_SAMPLE_COUNT && elapsedMs >= MIN_DURATION_MS;
    if (!isSettled) {
      pending.settledTs = null;
      const waitLimitMs = pending.firstSettledTs === null ? MAX_WAIT_MS : MAX_WAIT_MS + GROUP_MAX_MS;
      if (elapsedMs >= waitLimitMs) {
        return finish({ frame, skipReason: SCREEN_CHANGE_SKIP_REASON_MAP.neverSettled, isRebaselined: true });
      }
      return NO_RESULT;
    }
    if (pending.settledTs === null) pending.settledTs = ts;
    if (pending.firstSettledTs === null) pending.firstSettledTs = ts;

    if (!hasSignificant) return finish({ frame, skipReason: SCREEN_CHANGE_SKIP_REASON_MAP.tooSmall, isRebaselined: true });
    const isGroupClosed = ts - pending.settledTs >= GROUP_WINDOW_MS || ts - pending.firstSettledTs >= GROUP_MAX_MS;
    if (!isGroupClosed || isConfirming) return NO_RESULT;
    if (pending.hasPointing) return finish({ frame, skipReason: SCREEN_CHANGE_SKIP_REASON_MAP.pointing, isRebaselined: true });
    if (isScrolled({ baseGray: baseline.gray, currentGray: gray, width, height })) {
      return finish({ frame, skipReason: SCREEN_CHANGE_SKIP_REASON_MAP.scroll, isRebaselined: true });
    }
    const event = buildEvent({ currentRawMask: rawMask, ts });
    adopt(frame);
    return { ...NO_RESULT, event };
  }

  return { setBaseline, sample, reset, hasBaseline: () => Boolean(baseline) };
}
