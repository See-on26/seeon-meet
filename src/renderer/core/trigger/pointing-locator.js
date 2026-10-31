import { convertToGrayscale } from './ssim.js';
import { MAX_POINTING_CHANGED_RATIO } from './pointing-motion-tracker.js';

const DEFAULT_GRID_ROW_COUNT = 9;
const DEFAULT_GRID_COL_COUNT = 16;
const DEFAULT_CELL_CHANGE_THRESHOLD = 8;
const DEFAULT_MIN_CHANGED_CELLS = 1;
// 펜·레이저·커서는 화면의 작은 부분만 바꾼다. 발화 시점에 바로 붙이는 영역도 기억 경로의 움직임 거르개와 같은 상한을 쓴다.
const DEFAULT_MAX_CHANGED_RATIO = MAX_POINTING_CHANGED_RATIO;
const DEFAULT_WINDOW_MS = 2000;
const MERGE_CENTROID_DISTANCE = 0.15;
const MAX_SEQUENCE_EVENTS = 3;
// 웹캠·참가자 타일·재생 영상·시계처럼 계속 움직이는 칸은 가리킴이 아니다. 최근 15초 동안 표본의 60% 이상에서 변한 칸을
// 늘 변하는 칸으로 보고 가리킴 후보에서 뺀다. 15초는 가리킴을 보는 창(2초)보다 충분히 길어 한 번 가리키는 동작을
// 늘 변하는 것으로 잘못 보지 않는다. 영상·웹캠은 거의 모든 표본에서 바뀌지만, 펜·레이저 점은 대상 주위를 옮겨 다니고
// 멈춘 커서는 칸을 바꾸지 않아 한 칸을 과반보다 넉넉한 60% 의 표본에서 바꾸는 일이 드물다.
export const CONSTANT_CHANGE_WINDOW_MS = 15000;
export const CONSTANT_CHANGE_SAMPLE_RATIO = 0.6;

export function describeDirection({ x, y }) {
  const col = x < 1 / 3 ? '왼쪽' : x < 2 / 3 ? '가운데' : '오른쪽';
  const row = y < 1 / 3 ? '위' : y < 2 / 3 ? '중간' : '아래';
  if (col === '가운데' && row === '중간') return '가운데';
  if (col === '가운데') return row;
  if (row === '중간') return col;
  return `${col} ${row}`;
}

function unionOfRects(rectList) {
  const x0 = Math.min(...rectList.map((r) => r.x));
  const y0 = Math.min(...rectList.map((r) => r.y));
  const x1 = Math.max(...rectList.map((r) => r.x + r.w));
  const y1 = Math.max(...rectList.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function mergeNearbyEvents(eventList) {
  const mergedList = [];
  for (const event of eventList) {
    const last = mergedList[mergedList.length - 1];
    const isNear = last
      && Math.hypot(last.centroid.x - event.centroid.x, last.centroid.y - event.centroid.y) < MERGE_CENTROID_DISTANCE;
    if (isNear) mergedList[mergedList.length - 1] = event;
    else mergedList.push(event);
  }
  return mergedList;
}

function computeChangedCellMask({ grayA, grayB, width, height, rowCount, colCount, cellChangeThreshold }) {
  const changedCellMask = new Uint8Array(rowCount * colCount);
  for (let row = 0; row < rowCount; row += 1) {
    const cellY = Math.floor((row * height) / rowCount);
    const cellHeight = Math.floor(((row + 1) * height) / rowCount) - cellY;
    for (let col = 0; col < colCount; col += 1) {
      const cellX = Math.floor((col * width) / colCount);
      const cellWidth = Math.floor(((col + 1) * width) / colCount) - cellX;
      let diffSum = 0;
      for (let y = cellY; y < cellY + cellHeight; y += 1) {
        for (let x = cellX; x < cellX + cellWidth; x += 1) {
          const i = y * width + x;
          diffSum += Math.abs(grayA[i] - grayB[i]);
        }
      }
      const cellCount = cellWidth * cellHeight || 1;
      if (diffSum / cellCount > cellChangeThreshold) changedCellMask[row * colCount + col] = 1;
    }
  }
  return changedCellMask;
}

// excludedCellMask 에 든 칸(늘 변하는 칸)은 변했어도 영역·변화 비율에 세지 않는다. 그 칸을 빼고 남는 칸이 없으면 영역 없음이다.
export function computeChangeRegion({ grayA, grayB, width, height,
  rowCount = DEFAULT_GRID_ROW_COUNT, colCount = DEFAULT_GRID_COL_COUNT,
  cellChangeThreshold = DEFAULT_CELL_CHANGE_THRESHOLD, minChangedCells = DEFAULT_MIN_CHANGED_CELLS,
  maxChangedRatio = DEFAULT_MAX_CHANGED_RATIO, excludedCellMask = null }) {
  const changedCellMask = computeChangedCellMask({ grayA, grayB, width, height, rowCount, colCount, cellChangeThreshold });
  let minRow = Infinity; let minCol = Infinity; let maxRow = -1; let maxCol = -1; let changedCount = 0;
  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      const cellIndex = row * colCount + col;
      if (!changedCellMask[cellIndex] || excludedCellMask?.[cellIndex]) continue;
      changedCount += 1;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
    }
  }
  const totalCells = rowCount * colCount;
  const changedRatio = changedCount / totalCells;
  if (changedCount < minChangedCells || changedRatio > maxChangedRatio) {
    return { hasRegion: false, rect: null, changedRatio };
  }
  return {
    hasRegion: true,
    rect: {
      x: minCol / colCount,
      y: minRow / rowCount,
      w: (maxCol - minCol + 1) / colCount,
      h: (maxRow - minRow + 1) / rowCount,
    },
    changedRatio,
  };
}

export class PointingLocator {
  constructor({ windowMs = DEFAULT_WINDOW_MS, rowCount = DEFAULT_GRID_ROW_COUNT,
    colCount = DEFAULT_GRID_COL_COUNT, cellChangeThreshold = DEFAULT_CELL_CHANGE_THRESHOLD,
    maxChangedRatio = DEFAULT_MAX_CHANGED_RATIO, constantChangeWindowMs = CONSTANT_CHANGE_WINDOW_MS,
    constantChangeSampleRatio = CONSTANT_CHANGE_SAMPLE_RATIO } = {}) {
    this.windowMs = windowMs;
    this.rowCount = rowCount;
    this.colCount = colCount;
    this.cellChangeThreshold = cellChangeThreshold;
    this.maxChangedRatio = maxChangedRatio;
    this.constantChangeWindowMs = constantChangeWindowMs;
    this.constantChangeSampleRatio = constantChangeSampleRatio;
    this.sampleList = [];
    this.resetChangeHistory();
  }

  reset() {
    this.sampleList = [];
    this.resetChangeHistory();
  }

  // 슬라이드가 바뀌면 늘 변하는 칸도 달라진다. 최근 표본은 두고 칸 변화 기록만 비워 창을 다시 채운다.
  resetChangeHistory() {
    this.changeHistoryList = [];
    this.historyStartTs = null;
  }

  sample({ imageData, ts }) {
    const current = { ts, gray: convertToGrayscale(imageData), width: imageData.width, height: imageData.height };
    const previous = this.sampleList[this.sampleList.length - 1];
    this.sampleList.push(current);
    this.recordChangedCells({ previous, current });
    const cutoff = ts - this.windowMs * 2;
    while (this.sampleList.length > 2 && this.sampleList[0].ts < cutoff) this.sampleList.shift();
  }

  // 표본마다 앞 표본과 견줘 변한 칸을 적고, 창 밖으로 나간 기록은 버린다.
  recordChangedCells({ previous, current }) {
    if (this.historyStartTs === null) this.historyStartTs = current.ts;
    if (previous && previous.width === current.width && previous.height === current.height) {
      this.changeHistoryList.push({
        ts: current.ts,
        changedCellMask: computeChangedCellMask({
          grayA: previous.gray, grayB: current.gray, width: current.width, height: current.height,
          rowCount: this.rowCount, colCount: this.colCount, cellChangeThreshold: this.cellChangeThreshold,
        }),
      });
    }
    const cutoff = current.ts - this.constantChangeWindowMs;
    while (this.changeHistoryList.length && this.changeHistoryList[0].ts < cutoff) this.changeHistoryList.shift();
  }

  // 창이 다 차기 전에는 무엇이 늘 변하는지 알 수 없어 아무 칸도 빼지 않는다(null).
  findConstantChangeCells({ nowTs }) {
    if (this.historyStartTs === null || nowTs - this.historyStartTs < this.constantChangeWindowMs) return null;
    const recentList = this.changeHistoryList
      .filter((entry) => entry.ts <= nowTs && nowTs - entry.ts <= this.constantChangeWindowMs);
    if (!recentList.length) return null;
    const cellCount = this.rowCount * this.colCount;
    const constantCellMask = new Uint8Array(cellCount);
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      const changedCount = recentList.reduce((sum, entry) => sum + entry.changedCellMask[cellIndex], 0);
      if (changedCount / recentList.length >= this.constantChangeSampleRatio) constantCellMask[cellIndex] = 1;
    }
    return constantCellMask;
  }

  locate({ nowTs }) {
    if (this.sampleList.length < 2) return { hasRegion: false, rect: null };
    const current = this.sampleList[this.sampleList.length - 1];
    const reference = this.sampleList.find((s) => nowTs - s.ts <= this.windowMs) || this.sampleList[0];
    if (reference === current
      || reference.width !== current.width || reference.height !== current.height) {
      return { hasRegion: false, rect: null };
    }
    return computeChangeRegion({
      grayA: reference.gray, grayB: current.gray, width: current.width, height: current.height,
      rowCount: this.rowCount, colCount: this.colCount,
      cellChangeThreshold: this.cellChangeThreshold, maxChangedRatio: this.maxChangedRatio,
      excludedCellMask: this.findConstantChangeCells({ nowTs }),
    });
  }

  locateSequence({ nowTs }) {
    const inWindow = this.sampleList.filter((s) => nowTs - s.ts <= this.windowMs);
    if (inWindow.length < 2) return { hasRegion: false, unionRect: null, events: [] };
    const excludedCellMask = this.findConstantChangeCells({ nowTs });
    const eventList = [];
    for (let i = 1; i < inWindow.length; i += 1) {
      if (inWindow[i].width !== inWindow[i - 1].width || inWindow[i].height !== inWindow[i - 1].height) continue;
      const verdict = computeChangeRegion({
        grayA: inWindow[i - 1].gray, grayB: inWindow[i].gray,
        width: inWindow[i].width, height: inWindow[i].height,
        rowCount: this.rowCount, colCount: this.colCount,
        cellChangeThreshold: this.cellChangeThreshold, maxChangedRatio: this.maxChangedRatio, excludedCellMask,
      });
      if (verdict.hasRegion) {
        eventList.push({
          ts: inWindow[i].ts, rect: verdict.rect,
          centroid: { x: verdict.rect.x + verdict.rect.w / 2, y: verdict.rect.y + verdict.rect.h / 2 },
        });
      }
    }
    if (!eventList.length) return { hasRegion: false, unionRect: null, events: [] };
    const mergedList = mergeNearbyEvents(eventList).slice(-MAX_SEQUENCE_EVENTS);
    return { hasRegion: true, unionRect: unionOfRects(mergedList.map((e) => e.rect)), events: mergedList };
  }
}
