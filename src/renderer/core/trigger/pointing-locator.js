import { convertToGrayscale } from './ssim.js';

const DEFAULT_GRID_ROW_COUNT = 9;
const DEFAULT_GRID_COL_COUNT = 16;
const DEFAULT_CELL_CHANGE_THRESHOLD = 8;
const DEFAULT_MIN_CHANGED_CELLS = 1;
const DEFAULT_MAX_CHANGED_RATIO = 0.5;
const DEFAULT_WINDOW_MS = 2000;
const MERGE_CENTROID_DISTANCE = 0.15;
const MAX_SEQUENCE_EVENTS = 3;

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

export function computeChangeRegion({ grayA, grayB, width, height,
  rowCount = DEFAULT_GRID_ROW_COUNT, colCount = DEFAULT_GRID_COL_COUNT,
  cellChangeThreshold = DEFAULT_CELL_CHANGE_THRESHOLD, minChangedCells = DEFAULT_MIN_CHANGED_CELLS,
  maxChangedRatio = DEFAULT_MAX_CHANGED_RATIO }) {
  let minRow = Infinity; let minCol = Infinity; let maxRow = -1; let maxCol = -1; let changedCount = 0;
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
      if (diffSum / cellCount > cellChangeThreshold) {
        changedCount += 1;
        if (row < minRow) minRow = row;
        if (row > maxRow) maxRow = row;
        if (col < minCol) minCol = col;
        if (col > maxCol) maxCol = col;
      }
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
    maxChangedRatio = DEFAULT_MAX_CHANGED_RATIO } = {}) {
    this.windowMs = windowMs;
    this.rowCount = rowCount;
    this.colCount = colCount;
    this.cellChangeThreshold = cellChangeThreshold;
    this.maxChangedRatio = maxChangedRatio;
    this.sampleList = [];
  }

  reset() {
    this.sampleList = [];
  }

  sample({ imageData, ts }) {
    this.sampleList.push({
      ts, gray: convertToGrayscale(imageData), width: imageData.width, height: imageData.height,
    });
    const cutoff = ts - this.windowMs * 2;
    while (this.sampleList.length > 2 && this.sampleList[0].ts < cutoff) this.sampleList.shift();
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
    });
  }

  locateSequence({ nowTs }) {
    const inWindow = this.sampleList.filter((s) => nowTs - s.ts <= this.windowMs);
    if (inWindow.length < 2) return { hasRegion: false, unionRect: null, events: [] };
    const eventList = [];
    for (let i = 1; i < inWindow.length; i += 1) {
      if (inWindow[i].width !== inWindow[i - 1].width || inWindow[i].height !== inWindow[i - 1].height) continue;
      const verdict = computeChangeRegion({
        grayA: inWindow[i - 1].gray, grayB: inWindow[i].gray,
        width: inWindow[i].width, height: inWindow[i].height,
        rowCount: this.rowCount, colCount: this.colCount,
        cellChangeThreshold: this.cellChangeThreshold, maxChangedRatio: this.maxChangedRatio,
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
