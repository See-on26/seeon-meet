import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PointingLocator, computeChangeRegion, CONSTANT_CHANGE_WINDOW_MS, CONSTANT_CHANGE_SAMPLE_RATIO,
} from '../src/renderer/core/trigger/pointing-locator.js';
import { MAX_POINTING_CHANGED_RATIO } from '../src/renderer/core/trigger/pointing-motion-tracker.js';

// 제품과 같은 32×18 격자·칸 문턱 4. 시험 화면은 칸 하나를 화소 하나로 둔 32×18 그림이다.
const COL_COUNT = 32;
const ROW_COUNT = 18;
const STEP_MS = 400;
const START_TS = 10_000;

const createLocator = () => new PointingLocator({ rowCount: ROW_COUNT, colCount: COL_COUNT, cellChangeThreshold: 4 });
const cellRect = ({ col, row }) => ({ x: col / COL_COUNT, y: row / ROW_COUNT, w: 1 / COL_COUNT, h: 1 / ROW_COUNT });
const tsAt = (index) => START_TS + index * STEP_MS;

// 순서열 영역은 사각형을 합치며 부동소수 오차가 붙는다.
function assertSameRect(actual, expected) {
  assert.ok(actual, '영역 없음');
  for (const key of ['x', 'y', 'w', 'h']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} ≠ ${expected[key]}`);
  }
}

function makeImageData(cellList = []) {
  const data = new Uint8ClampedArray(COL_COUNT * ROW_COUNT * 4);
  for (const { col, row, value } of cellList) {
    const offset = (row * COL_COUNT + col) * 4;
    data.fill(value, offset, offset + 3);
  }
  return { data, width: COL_COUNT, height: ROW_COUNT };
}

// index 번째 표본부터 count 개를 400ms 간격으로 넣고 마지막 표본 시각을 돌려준다.
function feed(locator, { fromIndex = 0, count, buildCellList }) {
  for (let index = fromIndex; index < fromIndex + count; index += 1) {
    locator.sample({ imageData: makeImageData(buildCellList(index)), ts: tsAt(index) });
  }
  return tsAt(fromIndex + count - 1);
}

// 웹캠 타일처럼 표본마다 밝기가 바뀌는 칸.
const WEBCAM = { col: 30, row: 1 };
const webcamAt = (index) => ({ ...WEBCAM, value: index % 2 ? 200 : 40 });
// 창(15초)이 다 차는 첫 표본: 첫 표본 뒤 15.2초.
const FULL_WINDOW_COUNT = Math.ceil(CONSTANT_CHANGE_WINDOW_MS / STEP_MS) + 1;

test('기준값: 최근 15초 창에서 표본의 60% 이상 변한 칸을 늘 변하는 칸으로 본다', () => {
  assert.equal(CONSTANT_CHANGE_WINDOW_MS, 15_000);
  assert.equal(CONSTANT_CHANGE_SAMPLE_RATIO, 0.6);
});

test('변화 비율 상한은 움직임 거르개와 같은 0.1 이다', () => {
  assert.equal(MAX_POINTING_CHANGED_RATIO, 0.1);
  assert.equal(new PointingLocator().maxChangedRatio, MAX_POINTING_CHANGED_RATIO);
});

test('화면의 10% 를 넘게 한꺼번에 바뀌면 직접 경로(기준 비교·순서열) 모두 영역 없음(전체 화면)이다', () => {
  // 12×5=60칸(10.4%) 은 넘고, 11×5=55칸(9.5%) 은 넘지 않는다.
  const block = (colSpan) => Array.from({ length: colSpan * 5 }, (_, i) => ({ col: i % colSpan, row: 10 + Math.floor(i / colSpan), value: 200 }));
  const overLocator = createLocator();
  const overTs = feed(overLocator, { count: 2, buildCellList: (index) => (index ? block(12) : []) });
  assert.equal(overLocator.locate({ nowTs: overTs }).hasRegion, false);
  assert.equal(overLocator.locateSequence({ nowTs: overTs }).hasRegion, false);

  const underLocator = createLocator();
  const underTs = feed(underLocator, { count: 2, buildCellList: (index) => (index ? block(11) : []) });
  assert.equal(underLocator.locate({ nowTs: underTs }).hasRegion, true);
  assert.equal(underLocator.locateSequence({ nowTs: underTs }).hasRegion, true);
});

test('computeChangeRegion 은 뺄 칸으로 받은 칸을 변한 칸으로 세지 않는다', () => {
  const grayA = new Float64Array(COL_COUNT * ROW_COUNT);
  const grayB = new Float64Array(COL_COUNT * ROW_COUNT);
  grayB[WEBCAM.row * COL_COUNT + WEBCAM.col] = 200;
  grayB[9 * COL_COUNT + 10] = 200;
  const excludedCellMask = new Uint8Array(COL_COUNT * ROW_COUNT);
  excludedCellMask[WEBCAM.row * COL_COUNT + WEBCAM.col] = 1;
  const verdict = computeChangeRegion({
    grayA, grayB, width: COL_COUNT, height: ROW_COUNT, rowCount: ROW_COUNT, colCount: COL_COUNT,
    cellChangeThreshold: 4, excludedCellMask,
  });
  assert.equal(verdict.hasRegion, true);
  assertSameRect(verdict.rect, cellRect({ col: 10, row: 9 }));
  assert.equal(verdict.changedRatio, 1 / (COL_COUNT * ROW_COUNT));
});

test('15초 내내 변한 웹캠 칸은 빼고, 새로 가리킨 칸만 영역으로 잡는다(기준 비교·순서열)', () => {
  const locator = createLocator();
  feed(locator, { count: FULL_WINDOW_COUNT, buildCellList: (index) => [webcamAt(index)] });
  const pointer = { col: 10, row: 9 };
  const nowTs = feed(locator, {
    fromIndex: FULL_WINDOW_COUNT, count: 1, buildCellList: (index) => [webcamAt(index), { ...pointer, value: 255 }],
  });
  const located = locator.locate({ nowTs });
  assert.equal(located.hasRegion, true);
  assertSameRect(located.rect, cellRect(pointer));
  const sequence = locator.locateSequence({ nowTs });
  assert.equal(sequence.hasRegion, true);
  assertSameRect(sequence.unionRect, cellRect(pointer));
  assert.equal(sequence.events.length, 1);
});

test('늘 변하는 칸을 빼고 남는 칸이 없으면 영역 없음(전체 화면)이다', () => {
  const locator = createLocator();
  const nowTs = feed(locator, { count: FULL_WINDOW_COUNT + 2, buildCellList: (index) => [webcamAt(index)] });
  assert.equal(locator.locate({ nowTs }).hasRegion, false);
  assert.deepEqual(locator.locateSequence({ nowTs }), { hasRegion: false, unionRect: null, events: [] });
});

test('처음 15초 창이 다 차기 전에는 빼지 않고, 차면 뺀다', () => {
  const locator = createLocator();
  const beforeFullTs = feed(locator, { count: FULL_WINDOW_COUNT - 1, buildCellList: (index) => [webcamAt(index)] });
  assert.ok(beforeFullTs - START_TS < CONSTANT_CHANGE_WINDOW_MS);
  assertSameRect(locator.locate({ nowTs: beforeFullTs }).rect, cellRect(WEBCAM));
  assertSameRect(locator.locateSequence({ nowTs: beforeFullTs }).unionRect, cellRect(WEBCAM));

  const fullTs = feed(locator, { fromIndex: FULL_WINDOW_COUNT - 1, count: 1, buildCellList: (index) => [webcamAt(index)] });
  assert.ok(fullTs - START_TS >= CONSTANT_CHANGE_WINDOW_MS);
  assert.equal(locator.locate({ nowTs: fullTs }).hasRegion, false);
  assert.equal(locator.locateSequence({ nowTs: fullTs }).hasRegion, false);
});

test('표본의 60% 이상 변한 칸만 빼고, 절반만 변한 칸은 남긴다', () => {
  const twoOfThree = { col: 25, row: 4 };
  const half = { col: 5, row: 14 };
  const locator = createLocator();
  const nowTs = feed(locator, {
    count: FULL_WINDOW_COUNT + 3,
    buildCellList: (index) => [
      { ...twoOfThree, value: index % 3 === 1 ? 200 : 0 },
      { ...half, value: Math.floor(index / 2) % 2 ? 200 : 0 },
    ],
  });
  const sequence = locator.locateSequence({ nowTs });
  assert.equal(sequence.hasRegion, true);
  assertSameRect(sequence.unionRect, cellRect(half));
});

test('reset 은 늘 변하는 칸 기록도 비워, 다시 15초가 찰 때까지 빼지 않는다', () => {
  const locator = createLocator();
  feed(locator, { count: FULL_WINDOW_COUNT + 2, buildCellList: (index) => [webcamAt(index)] });
  locator.reset();
  const nowTs = feed(locator, { fromIndex: FULL_WINDOW_COUNT + 2, count: 2, buildCellList: (index) => [webcamAt(index)] });
  assertSameRect(locator.locate({ nowTs }).rect, cellRect(WEBCAM));
});

test('resetChangeHistory 는 늘 변하는 칸 기록만 비우고 최근 표본은 남긴다(슬라이드 전환용)', () => {
  const locator = createLocator();
  const nowTs = feed(locator, { count: FULL_WINDOW_COUNT + 2, buildCellList: (index) => [webcamAt(index)] });
  assert.equal(locator.locate({ nowTs }).hasRegion, false);
  locator.resetChangeHistory();
  assertSameRect(locator.locate({ nowTs }).rect, cellRect(WEBCAM));
  assertSameRect(locator.locateSequence({ nowTs }).unionRect, cellRect(WEBCAM));
  const laterTs = feed(locator, { fromIndex: FULL_WINDOW_COUNT + 2, count: FULL_WINDOW_COUNT, buildCellList: (index) => [webcamAt(index)] });
  assert.equal(locator.locate({ nowTs: laterTs }).hasRegion, false);
});

test('제품 화면은 슬라이드가 바뀌면 늘 변하는 칸 기록을 비우고, 공유 화면 좌표가 바뀌면 로컬라이저를 통째로 비운다', () => {
  const source = fs.readFileSync(new URL('../src/renderer/app/main.js', import.meta.url), 'utf8');
  const readBody = (signature) => {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, signature);
    return source.slice(start, source.indexOf('\n}\n', start));
  };
  const confirmBody = readBody('async function confirmSlideCandidate(');
  const transitionAt = confirmBody.indexOf('if (!decision.isNew && !decision.isRevisit) return;');
  assert.ok(transitionAt >= 0);
  assert.ok(confirmBody.indexOf('pointingLocator.resetChangeHistory();') > transitionAt);
  assert.match(readBody('function syncRoiGeneration('), /pointingLocator\.reset\(\);/);
  // 변화 비율 상한은 로컬라이저 기본값(0.1)을 그대로 쓴다.
  assert.match(source, /new PointingLocator\(\{ rowCount: 18, colCount: 32, cellChangeThreshold: 4 \}\)/);
});
