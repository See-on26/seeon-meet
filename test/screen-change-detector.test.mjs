import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScreenChangeDetector, SCREEN_CHANGE_SKIP_REASON_MAP,
} from '../src/renderer/core/trigger/screen-change-detector.js';

// 32×18 격자에 5px 칸이 되는 160×90 회색조 화면. 흰 바탕(240)에 칸 단위로 어두운 덩어리를 그린다.
const WIDTH = 160;
const HEIGHT = 90;
const CELL_PX = 5;
const SAMPLE_MS = 400;

function makeFrame({ blockList = [], base = null } = {}) {
  const gray = base ? Float64Array.from(base) : new Float64Array(WIDTH * HEIGHT).fill(240);
  for (const { col, row, colCount = 1, rowCount = 1, value = 30 } of blockList) {
    for (let y = row * CELL_PX; y < (row + rowCount) * CELL_PX; y += 1) {
      for (let x = col * CELL_PX; x < (col + colCount) * CELL_PX; x += 1) gray[y * WIDTH + x] = value;
    }
  }
  return gray;
}

// 글줄처럼 가로 막대가 여러 줄 있는 화면. 스크롤 시험에 쓴다.
function makeTextLikeFrame({ shiftY = 0 } = {}) {
  const gray = new Float64Array(WIDTH * HEIGHT).fill(240);
  const barList = [
    { y: 8, h: 4, x0: 10, x1: 120, value: 40 },
    { y: 22, h: 3, x0: 10, x1: 90, value: 90 },
    { y: 36, h: 5, x0: 20, x1: 150, value: 20 },
    { y: 52, h: 3, x0: 10, x1: 70, value: 120 },
    { y: 64, h: 4, x0: 30, x1: 140, value: 60 },
    { y: 78, h: 3, x0: 10, x1: 100, value: 80 },
  ];
  for (const bar of barList) {
    for (let y = bar.y; y < bar.y + bar.h; y += 1) {
      const shifted = y + shiftY;
      if (shifted < 0 || shifted >= HEIGHT) continue;
      for (let x = bar.x0; x < bar.x1; x += 1) gray[shifted * WIDTH + x] = bar.value;
    }
  }
  return gray;
}

// 기준을 잡은 감지기와, 표본을 차례로 넣고 결과를 모으는 도우미.
function createHarness({ baseline = makeFrame(), startTs = 0, option = {} } = {}) {
  const detector = createScreenChangeDetector(option);
  let ts = startTs;
  const first = detector.sample({ gray: baseline, width: WIDTH, height: HEIGHT, ts, videoTimeMs: ts });
  assert.equal(first.isBaselineCommitted, true);
  const eventList = [];
  const skipList = [];
  function feed(gray, { count = 1, ...extra } = {}) {
    let last = null;
    for (let i = 0; i < count; i += 1) {
      ts += SAMPLE_MS;
      last = detector.sample({ gray, width: WIDTH, height: HEIGHT, ts, videoTimeMs: ts + 100000, ...extra });
      if (last.event) eventList.push(last.event);
      if (last.skipReason) skipList.push(last.skipReason);
    }
    return last;
  }
  return { detector, feed, eventList, skipList, now: () => ts };
}

test('같은 화면을 거듭 넣으면 사건이 없다', () => {
  const { feed, eventList, skipList } = createHarness();
  feed(makeFrame(), { count: 20 });
  assert.equal(eventList.length, 0);
  assert.equal(skipList.length, 0);
});

test('4×2칸이 바뀌어 머물면 사건 1건 — 영역은 그 칸, 처음 본 시각은 처음 바뀐 표본', () => {
  const { feed, eventList } = createHarness();
  const changed = makeFrame({ blockList: [{ col: 10, row: 4, colCount: 4, rowCount: 2 }] });
  feed(changed, { count: 10 });
  assert.equal(eventList.length, 1);
  const [event] = eventList;
  assert.equal(event.cellCount, 8);
  assert.equal(event.firstSeenTs, SAMPLE_MS);
  assert.equal(event.firstSeenVideoTimeMs, SAMPLE_MS + 100000);
  assert.ok(event.settledTs > event.firstSeenTs);
  assert.deepEqual(
    { x: event.rect.x, y: event.rect.y, w: event.rect.w, h: event.rect.h },
    { x: 10 / 32, y: 4 / 18, w: 4 / 32, h: 2 / 18 },
  );
  assert.ok(Math.abs(event.changedRatio - 8 / 576) < 1e-9);
});

test('정착하려면 처음 바뀐 뒤 1.6초가 지나야 하고, 정착 뒤 0.8초를 더 묶어 본다', () => {
  const { feed, eventList, now } = createHarness();
  const changed = makeFrame({ blockList: [{ col: 2, row: 2, colCount: 3, rowCount: 3 }] });
  feed(changed, { count: 6 });
  assert.equal(eventList.length, 0, '2.4초째(정착 2.0초 + 묶기 0.4초)에는 아직 내지 않는다');
  feed(changed, { count: 1 });
  assert.equal(eventList.length, 1);
  assert.equal(now() - eventList[0].firstSeenTs, 2400);
});

test('바뀐 덩어리가 두 표본 뒤 원래대로 돌아가면 사건이 없다(reverted)', () => {
  const { feed, eventList, skipList } = createHarness();
  const changed = makeFrame({ blockList: [{ col: 10, row: 4, colCount: 4, rowCount: 2 }] });
  feed(changed, { count: 2 });
  const last = feed(makeFrame());
  assert.equal(last.skipReason, SCREEN_CHANGE_SKIP_REASON_MAP.reverted);
  feed(makeFrame(), { count: 10 });
  assert.equal(eventList.length, 0);
  assert.deepEqual(skipList, ['reverted']);
});

test('1칸(커서)이 바뀌어 머물거나 떨어진 1칸 두 곳이 바뀌면 사건이 없다(too_small)', () => {
  const single = createHarness();
  single.feed(makeFrame({ blockList: [{ col: 5, row: 5 }] }), { count: 12 });
  assert.equal(single.eventList.length, 0);
  assert.deepEqual(single.skipList, ['too_small']);

  const scattered = createHarness();
  scattered.feed(makeFrame({ blockList: [{ col: 5, row: 5 }, { col: 20, row: 12 }] }), { count: 12 });
  assert.equal(scattered.eventList.length, 0);
  assert.deepEqual(scattered.skipList, ['too_small']);
});

test('늘 변하는 칸만 계속 바뀌면 사건이 없고, 다른 곳 덩어리의 영역에는 그 칸이 들지 않는다', () => {
  const excludedCellMask = new Uint8Array(32 * 18);
  for (let row = 0; row < 4; row += 1) for (let col = 26; col < 32; col += 1) excludedCellMask[row * 32 + col] = 1;
  const { feed, eventList, skipList } = createHarness();
  for (let i = 0; i < 12; i += 1) {
    feed(makeFrame({ blockList: [{ col: 26, row: 0, colCount: 6, rowCount: 4, value: i % 2 ? 10 : 120 }] }), { excludedCellMask });
  }
  assert.equal(eventList.length, 0);
  assert.equal(skipList.length, 0);

  for (let i = 0; i < 10; i += 1) {
    feed(makeFrame({
      blockList: [
        { col: 26, row: 0, colCount: 6, rowCount: 4, value: i % 2 ? 10 : 120 },
        { col: 4, row: 10, colCount: 3, rowCount: 2 },
      ],
    }), { excludedCellMask });
  }
  assert.equal(eventList.length, 1);
  assert.equal(eventList[0].cellCount, 6);
  assert.deepEqual(eventList[0].rect, { x: 4 / 32, y: 10 / 18, w: 3 / 32, h: 2 / 18 });
});

test('한 영역이 표본마다 바뀌는 영상은 6초가 지나면 버리고(never_settled) 기준을 다시 잡는다', () => {
  const { feed, eventList, skipList } = createHarness();
  let last = null;
  for (let i = 0; i < 16; i += 1) {
    last = makeFrame({ blockList: [{ col: 8, row: 6, colCount: 6, rowCount: 4, value: (i * 37) % 200 }] });
    feed(last);
    if (skipList.length) break;
  }
  assert.deepEqual(skipList, ['never_settled']);
  feed(last, { count: 10 });
  assert.equal(eventList.length, 0);
  assert.deepEqual(skipList, ['never_settled']);
});

test('화면 전체가 세로로 12px 밀리면 스크롤로 보고 사건이 없다, 같은 그림이 이어져도 없다', () => {
  const { feed, eventList, skipList } = createHarness({ baseline: makeTextLikeFrame() });
  const scrolled = makeTextLikeFrame({ shiftY: 12 });
  feed(scrolled, { count: 10 });
  assert.equal(eventList.length, 0);
  assert.deepEqual(skipList, ['scroll']);
  feed(scrolled, { count: 10 });
  assert.equal(eventList.length, 0);
  assert.deepEqual(skipList, ['scroll']);
});

test('빈 바탕 가장자리 근처에 새 글줄이 뜨면 스크롤이 아니라 사건이다', () => {
  for (const row of [3, 4, 13]) {
    const { feed, eventList, skipList } = createHarness();
    feed(makeFrame({ blockList: [{ col: 3, row, colCount: 20, rowCount: 1, value: 50 }] }), { count: 10 });
    assert.equal(eventList.length, 1, `행 ${row}`);
    assert.deepEqual(skipList, [], `행 ${row}`);
  }
});

test('바뀐 칸이 40%를 넘으면 사건이 없다(too_large)', () => {
  const { feed, eventList, skipList } = createHarness();
  // 32×18 중 260칸(45%)을 고르게 바꾼다. 행마다 밝기가 달라 스크롤로 맞춰지지 않는다.
  const changed = makeFrame({
    blockList: Array.from({ length: 13 }, (_, row) => ({ col: 0, row, colCount: 20, rowCount: 1, value: 10 + row * 7 })),
  });
  feed(changed, { count: 10 });
  assert.equal(eventList.length, 0);
  assert.deepEqual(skipList, ['too_large']);
});

test('기다리는 동안 가리킴 움직임이 있었으면 사건이 없고(pointing) 기준이 다시 잡힌다', () => {
  const { feed, eventList, skipList } = createHarness();
  const changed = makeFrame({ blockList: [{ col: 10, row: 4, colCount: 4, rowCount: 2 }] });
  feed(changed, { count: 1, isPointingActive: true });
  feed(changed, { count: 10 });
  assert.equal(eventList.length, 0);
  assert.deepEqual(skipList, ['pointing']);
  feed(changed, { count: 10 });
  assert.equal(eventList.length, 0);
});

test('사건 뒤 같은 화면이면 다시 내지 않고, 새 덩어리가 생기면 그 덩어리만 담은 사건을 낸다', () => {
  const { feed, eventList } = createHarness();
  const first = makeFrame({ blockList: [{ col: 2, row: 2, colCount: 3, rowCount: 2 }] });
  feed(first, { count: 10 });
  assert.equal(eventList.length, 1);
  feed(first, { count: 10 });
  assert.equal(eventList.length, 1);
  const second = makeFrame({ base: first, blockList: [{ col: 20, row: 12, colCount: 4, rowCount: 3 }] });
  feed(second, { count: 10 });
  assert.equal(eventList.length, 2);
  assert.equal(eventList[1].cellCount, 12);
  assert.deepEqual(eventList[1].rect, { x: 20 / 32, y: 12 / 18, w: 4 / 32, h: 3 / 18 });
});

test('0.6초 간격으로 두 덩어리가 나타나면 합집합 영역의 사건 1건이다', () => {
  const { feed, eventList } = createHarness();
  const first = makeFrame({ blockList: [{ col: 2, row: 2, colCount: 3, rowCount: 1 }] });
  const both = makeFrame({ base: first, blockList: [{ col: 2, row: 4, colCount: 5, rowCount: 1 }] });
  feed(first, { count: 2 });
  feed(both, { count: 12 });
  assert.equal(eventList.length, 1);
  assert.equal(eventList[0].cellCount, 8);
  assert.deepEqual(eventList[0].rect, { x: 2 / 32, y: 2 / 18, w: 5 / 32, h: 3 / 18 });
  assert.equal(eventList[0].firstSeenTs, SAMPLE_MS);
});

test('전환 확정 중에는 내보내지 않고, 새 슬라이드 기준을 잡으면 앞에 기다리던 것을 버린다', () => {
  const { detector, feed, eventList, now } = createHarness();
  const changed = makeFrame({ blockList: [{ col: 10, row: 4, colCount: 4, rowCount: 2 }] });
  feed(changed, { count: 10, isConfirming: true });
  assert.equal(eventList.length, 0);
  detector.setBaseline({ ts: now(), isSlideStart: true });
  feed(changed, { count: 5 });
  assert.equal(eventList.length, 0);
});

test('새 슬라이드 기준 뒤 4초는 조용하고, 4초가 지나면 그때 화면이 기준이 된다', () => {
  const detector = createScreenChangeDetector();
  detector.setBaseline({ ts: 0, isSlideStart: true });
  const building = makeFrame({ blockList: [{ col: 4, row: 4, colCount: 6, rowCount: 3 }] });
  const resultList = [];
  for (let ts = SAMPLE_MS; ts < 4000; ts += SAMPLE_MS) {
    resultList.push(detector.sample({ gray: ts < 2000 ? makeFrame() : building, width: WIDTH, height: HEIGHT, ts }));
  }
  assert.ok(resultList.every((result) => !result.event && !result.skipReason && !result.isBaselineCommitted));
  const committed = detector.sample({ gray: building, width: WIDTH, height: HEIGHT, ts: 4000 });
  assert.equal(committed.isBaselineCommitted, true);
  assert.equal(committed.isSlideStart, true);
  for (let ts = 4400; ts < 10000; ts += SAMPLE_MS) {
    const result = detector.sample({ gray: building, width: WIDTH, height: HEIGHT, ts });
    assert.equal(result.event, null);
    assert.equal(result.skipReason, null);
  }
});

test('reset 뒤 첫 표본은 기준으로 삼고 알린다(슬라이드 시작이 아님)', () => {
  const { detector, feed } = createHarness();
  detector.reset();
  const result = feed(makeFrame());
  assert.equal(result.isBaselineCommitted, true);
  assert.equal(result.isSlideStart, false);
});
