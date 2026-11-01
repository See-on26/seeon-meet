import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  findAppearanceRect, createAppearanceTracker, pickDeixisRegion,
  APPEARED_REGION_KIND, APPEARANCE_MIN_AREA_RATIO, APPEARANCE_MAX_AREA_RATIO,
  APPEARANCE_RECALL_WINDOW_MS, SETTLED_BASE_MAX_AGE_MS, DEIXIS_REGION_SOURCE_MAP,
} from '../src/renderer/core/trigger/appeared-region.js';
import { MAX_POINTING_CHANGED_RATIO } from '../src/renderer/core/trigger/pointing-motion-tracker.js';
import { toPointingRect, APPEARED_CROP_MARGIN } from '../src/renderer/core/capture/deixis-frame-set.js';

const require = createRequire(import.meta.url);
const { ZOOM_KIND_MAP } = require('../src/main/caption-pipeline/prompts/zoom-image-intro.js');

// 제품과 같은 32×18 격자. 시험 화면은 칸 하나를 화소 하나로 둔 32×18 그림이다(바탕 0, 그림 200).
const COL_COUNT = 32;
const ROW_COUNT = 18;
const STEP_MS = 400;
const START_TS = 10_000;
const START_WALL_TS = 1_700_000_000_000;

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function readFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, signature);
  return source.slice(start, source.indexOf('\n}\n', start));
}

// blockList: [{ col, row, w, h, value }] — 칸 단위 사각형.
function makeGray(blockList = []) {
  const gray = new Float64Array(COL_COUNT * ROW_COUNT);
  for (const { col, row, w = 1, h = 1, value = 200 } of blockList) {
    for (let r = row; r < row + h; r += 1) {
      for (let c = col; c < col + w; c += 1) gray[r * COL_COUNT + c] = value;
    }
  }
  return gray;
}

function makeImageData(blockList = []) {
  const gray = makeGray(blockList);
  const data = new Uint8ClampedArray(COL_COUNT * ROW_COUNT * 4);
  gray.forEach((value, index) => data.fill(value, index * 4, index * 4 + 3));
  return { data, width: COL_COUNT, height: ROW_COUNT };
}

const blockRect = ({ col, row, w, h }) => ({ x: col / COL_COUNT, y: row / ROW_COUNT, w: w / COL_COUNT, h: h / ROW_COUNT });
const findRect = (baseList, currentList, option = {}) => findAppearanceRect({
  baseGray: makeGray(baseList), currentGray: makeGray(currentList), width: COL_COUNT, height: ROW_COUNT, ...option,
});

function assertSameRect(actual, expected) {
  assert.ok(actual, '영역 없음');
  for (const key of ['x', 'y', 'w', 'h']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} ≠ ${expected[key]}`);
  }
}

// 표본기: 400ms 간격으로 같은 화면을 count 번 넣고 마지막 표본 시각을 돌려준다.
function createFeeder(tracker) {
  let index = 0;
  return {
    feed(blockList, count = 1) {
      for (let i = 0; i < count; i += 1) {
        tracker.sample({ imageData: makeImageData(blockList), ts: START_TS + index * STEP_MS });
        index += 1;
      }
      return START_TS + (index - 1) * STEP_MS;
    },
    nowTs: () => START_TS + (index - 1) * STEP_MS,
  };
}

const TITLE = { col: 2, row: 1, w: 12, h: 1, value: 120 };
// 붙여 넣은 그림: 8칸 × 14칸 = 화면의 약 19%.
const PICTURE_LEFT = { col: 2, row: 3, w: 8, h: 14 };
const PICTURE_RIGHT = { col: 22, row: 3, w: 8, h: 14 };

// ── 기준값 ──

test('기준값: 나타난 그림은 화면의 10~50% 를 덮는 바뀐 칸 상자이고, 10% 아래는 가리킴 상한과 같다', () => {
  assert.equal(APPEARANCE_MIN_AREA_RATIO, MAX_POINTING_CHANGED_RATIO);
  assert.equal(APPEARANCE_MIN_AREA_RATIO, 0.1);
  assert.equal(APPEARANCE_MAX_AREA_RATIO, 0.5);
  assert.equal(APPEARANCE_RECALL_WINDOW_MS, 5000);
  assert.equal(SETTLED_BASE_MAX_AGE_MS, 15000);
});

test('렌더러가 영역에 붙이는 종류 이름은 main 의 확대 종류(appeared)와 같다', () => {
  assert.equal(APPEARED_REGION_KIND, 'appeared');
  assert.equal(APPEARED_REGION_KIND, ZOOM_KIND_MAP.appeared);
});

// ── 영역 고르기 ──

test('정지 화면과 견줘 바뀐 칸 상자가 화면의 10~50% 이면 그 상자를 돌려준다', () => {
  const block = { col: 4, row: 4, w: 8, h: 8 };
  assertSameRect(findRect([], [block]), blockRect(block));
  assertSameRect(findRect([TITLE], [TITLE, PICTURE_LEFT]), blockRect(PICTURE_LEFT));
  // 화면 절반(경계값)까지 받는다.
  const half = { col: 0, row: 0, w: 16, h: 18 };
  assertSameRect(findRect([], [half]), blockRect(half));
});

test('바뀐 칸 상자가 화면의 10% 보다 작으면(가리킴 몫) 영역이 아니다', () => {
  assert.equal(findRect([], [{ col: 4, row: 4, w: 6, h: 6 }]), null);
  assert.equal(findRect([], [{ col: 4, row: 4, w: 3, h: 3 }]), null);
});

test('화면의 절반을 넘게 바뀌면(슬라이드 전체 전환) 영역이 아니다', () => {
  assert.equal(findRect([], [{ col: 0, row: 0, w: 20, h: 18 }]), null);
  assert.equal(findRect([TITLE], [{ col: 0, row: 0, w: 32, h: 18, value: 90 }]), null);
  // 바뀐 칸은 적어도 두 덩어리가 화면 양 끝에 떨어져 상자가 절반을 넘으면 뺀다.
  assert.equal(findRect([], [{ col: 0, row: 0, w: 4, h: 4 }, { col: 28, row: 14, w: 4, h: 4 }]), null);
});

test('같은 화면이면 영역이 없다', () => {
  assert.equal(findRect([TITLE, PICTURE_LEFT], [TITLE, PICTURE_LEFT]), null);
});

test('커서 같은 작은 덩어리(3칸 미만)는 상자를 넓히지 않는다', () => {
  const cursorBefore = { col: 28, row: 2 };
  const cursorAfter = { col: 30, row: 16, w: 1, h: 2 };
  assertSameRect(findRect([TITLE, cursorBefore], [TITLE, PICTURE_LEFT, cursorAfter]), blockRect(PICTURE_LEFT));
});

test('늘 변하는 칸(웹캠·재생 영상)은 상자에 넣지 않는다', () => {
  const webcam = { col: 26, row: 0, w: 4, h: 3 };
  const excludedCellMask = new Uint8Array(COL_COUNT * ROW_COUNT);
  for (let row = 0; row < 3; row += 1) for (let col = 26; col < 30; col += 1) excludedCellMask[row * COL_COUNT + col] = 1;
  assertSameRect(findRect([], [PICTURE_LEFT, webcam], { excludedCellMask }), blockRect(PICTURE_LEFT));
  // 빼지 않으면 상자가 화면 끝의 웹캠까지 넓어져 절반을 넘고 영역을 잃는다.
  assert.equal(findRect([], [PICTURE_LEFT, webcam]), null);
});

// ── 직전 정지 화면 추적과 기억 ──

test('그림을 붙여 넣고 멈추면 직전 정지 화면과 견준 상자를 기억하고, 같은 슬라이드 지시 발화에 종류를 붙여 돌려준다', () => {
  const tracker = createAppearanceTracker();
  const feeder = createFeeder(tracker);
  feeder.feed([TITLE], 4);
  feeder.feed([TITLE, PICTURE_LEFT], 4);
  const rect = tracker.capture({ slideLabel: '3', wallTs: START_WALL_TS, nowTs: feeder.nowTs() });
  assertSameRect(rect, blockRect(PICTURE_LEFT));
  const region = tracker.recall({ eventWallTs: START_WALL_TS + 1000, slideLabel: '3' });
  assertSameRect(region, blockRect(PICTURE_LEFT));
  assert.equal(region.kind, APPEARED_REGION_KIND);
});

test('바뀐 화면이 아직 굳기 전(전환 확정이 빠른 경우)에도 직전 정지 화면과 견준다', () => {
  const tracker = createAppearanceTracker();
  const feeder = createFeeder(tracker);
  feeder.feed([TITLE], 4);
  feeder.feed([TITLE, PICTURE_LEFT], 1);
  assertSameRect(tracker.capture({ slideLabel: '3', wallTs: START_WALL_TS, nowTs: feeder.nowTs() }), blockRect(PICTURE_LEFT));
});

test('붙여 넣은 자리에서 잠시 멈춘 뒤 끌어 옮기면, 두 자리를 묶은 상자가 너무 커서 그 앞 정지 화면과 견준 상자를 쓴다', () => {
  const tracker = createAppearanceTracker();
  const feeder = createFeeder(tracker);
  feeder.feed([TITLE], 4);
  feeder.feed([TITLE, PICTURE_RIGHT], 4);
  feeder.feed([TITLE, PICTURE_LEFT], 4);
  assertSameRect(tracker.capture({ slideLabel: '3', wallTs: START_WALL_TS, nowTs: feeder.nowTs() }), blockRect(PICTURE_LEFT));
});

test('슬라이드 전체가 바뀌었으면 기억하지 않는다', () => {
  const tracker = createAppearanceTracker();
  const feeder = createFeeder(tracker);
  feeder.feed([TITLE], 4);
  feeder.feed([{ col: 0, row: 0, w: 32, h: 18, value: 90 }, { col: 2, row: 1, w: 12, h: 1, value: 250 }], 4);
  assert.equal(tracker.capture({ slideLabel: '4', wallTs: START_WALL_TS, nowTs: feeder.nowTs() }), null);
  assert.equal(tracker.recall({ eventWallTs: START_WALL_TS, slideLabel: '4' }), null);
});

test('직전 정지 화면이 15초보다 오래전에 사라졌으면(계속 움직이는 화면) 견주지 않는다', () => {
  // 그림 옆 작은 칸이 표본마다 깜빡여 화면이 굳지 않는다. 상자(그림 + 깜빡이는 칸)는 화면의 약 24% 다.
  const captureAfterMoving = (movingCount) => {
    const tracker = createAppearanceTracker();
    const feeder = createFeeder(tracker);
    feeder.feed([TITLE], 4);
    for (let i = 0; i < movingCount; i += 1) feeder.feed([TITLE, PICTURE_LEFT, { col: 10, row: 3, w: 2, h: 2, value: i % 2 ? 60 : 220 }]);
    return tracker.capture({ slideLabel: '3', wallTs: START_WALL_TS, nowTs: feeder.nowTs() });
  };
  assert.ok(captureAfterMoving(5));
  assert.equal(captureAfterMoving(Math.ceil(SETTLED_BASE_MAX_AGE_MS / STEP_MS) + 2), null);
});

test('다른 슬라이드의 지시 발화에는 붙이지 않는다', () => {
  const tracker = createAppearanceTracker();
  const feeder = createFeeder(tracker);
  feeder.feed([TITLE], 4);
  feeder.feed([TITLE, PICTURE_LEFT], 4);
  tracker.capture({ slideLabel: '3', wallTs: START_WALL_TS, nowTs: feeder.nowTs() });
  assert.equal(tracker.recall({ eventWallTs: START_WALL_TS + 1000, slideLabel: '4' }), null);
});

test('트리거 발화 끝보다 5초 넘게 앞서 나타난 그림은 붙이지 않고, 발화 끝 뒤(전사 도착 전)에 나타난 그림은 붙인다', () => {
  const tracker = createAppearanceTracker();
  const feeder = createFeeder(tracker);
  feeder.feed([TITLE], 4);
  feeder.feed([TITLE, PICTURE_LEFT], 4);
  tracker.capture({ slideLabel: '3', wallTs: START_WALL_TS, nowTs: feeder.nowTs() });
  assert.ok(tracker.recall({ eventWallTs: START_WALL_TS + APPEARANCE_RECALL_WINDOW_MS, slideLabel: '3' }));
  assert.equal(tracker.recall({ eventWallTs: START_WALL_TS + APPEARANCE_RECALL_WINDOW_MS + 1, slideLabel: '3' }), null);
  assert.ok(tracker.recall({ eventWallTs: START_WALL_TS - 800, slideLabel: '3' }));
  assert.equal(tracker.recall({ eventWallTs: null, slideLabel: '3' }), null);
});

test('직전 변화가 작으면(가리킴 몫) 그 앞 변화로 거슬러 가지 않고, 앞서 기억한 영역도 지우지 않는다', () => {
  const tracker = createAppearanceTracker();
  const feeder = createFeeder(tracker);
  feeder.feed([TITLE], 4);
  feeder.feed([TITLE, PICTURE_LEFT], 4);
  tracker.capture({ slideLabel: '3', wallTs: START_WALL_TS, nowTs: feeder.nowTs() });
  feeder.feed([TITLE, PICTURE_LEFT, { col: 20, row: 10, w: 2, h: 2 }], 4);
  assert.equal(tracker.capture({ slideLabel: '3', wallTs: START_WALL_TS + 2000, nowTs: feeder.nowTs() }), null);
  assertSameRect(tracker.recall({ eventWallTs: START_WALL_TS + 3000, slideLabel: '3' }), blockRect(PICTURE_LEFT));
});

test('지우면(캡처 다시 시작·공유 화면 영역 변경) 기억도 정지 화면도 없다', () => {
  const tracker = createAppearanceTracker();
  const feeder = createFeeder(tracker);
  feeder.feed([TITLE], 4);
  feeder.feed([TITLE, PICTURE_LEFT], 4);
  tracker.capture({ slideLabel: '3', wallTs: START_WALL_TS, nowTs: feeder.nowTs() });
  tracker.reset();
  assert.equal(tracker.recall({ eventWallTs: START_WALL_TS, slideLabel: '3' }), null);
  assert.equal(tracker.capture({ slideLabel: '3', wallTs: START_WALL_TS, nowTs: feeder.nowTs() }), null);
});

// ── 지시 발화에 붙일 영역의 순서 ──

const pointingSequence = { region: { x: 0.5, y: 0.5, w: 0.05, h: 0.05 }, pointingOrderHint: '1) 가운데, 2) 오른쪽' };
const emptySequence = { region: null, pointingOrderHint: '' };
const recalledPointing = { region: { x: 0.2, y: 0.2, w: 0.06, h: 0.06 }, pointingOrderHint: '' };
const appearedRegion = { ...blockRect(PICTURE_LEFT), kind: APPEARED_REGION_KIND };

test('지시 영역 순서: 직전 창의 가리킴 → 발화 전 가리킨 기억 → 방금 나타난 그림 → 없음(전체 화면)', () => {
  assert.deepEqual(pickDeixisRegion({ sequence: pointingSequence, recalledPointing, appearedRegion }),
    { ...pointingSequence, source: DEIXIS_REGION_SOURCE_MAP.pointing });
  assert.deepEqual(pickDeixisRegion({ sequence: emptySequence, recalledPointing, appearedRegion }),
    { ...recalledPointing, source: DEIXIS_REGION_SOURCE_MAP.recalledPointing });
  assert.deepEqual(pickDeixisRegion({ sequence: emptySequence, recalledPointing: null, appearedRegion }),
    { region: appearedRegion, pointingOrderHint: '', source: DEIXIS_REGION_SOURCE_MAP.appeared });
  assert.deepEqual(pickDeixisRegion({ sequence: emptySequence, recalledPointing: null, appearedRegion: null }),
    { region: null, pointingOrderHint: '', source: DEIXIS_REGION_SOURCE_MAP.none });
});

// ── 자르기 여백·main 에 보내는 비율 상자 ──

test('나타난 그림 영역은 가리킴 여백 대신 칸 하나 크기 여백으로 자르고, 비율 상자에 종류를 붙인다', () => {
  assert.equal(APPEARED_CROP_MARGIN, 0.03);
  const subRegion = { x: 0.1, y: 0.2, w: 0.2, h: 0.7, kind: APPEARED_REGION_KIND };
  assert.deepEqual(toPointingRect({ subRegion, margin: 0.12 }), { x: 0.07, y: 0.17, w: 0.26, h: 0.76, kind: APPEARED_REGION_KIND });
  const clamped = toPointingRect({ subRegion: { x: 0.01, y: 0.5, w: 0.3, h: 0.49, kind: APPEARED_REGION_KIND }, margin: 0.12 });
  assert.deepEqual(clamped, { x: 0, y: 0.47, w: 0.34, h: 0.53, kind: APPEARED_REGION_KIND });
  // 펜·레이저 가리킴은 지금처럼 가리킴 여백이고 종류가 없다.
  assert.deepEqual(toPointingRect({ subRegion: { x: 0.5, y: 0.25, w: 0.1, h: 0.2 }, margin: 0.12 }), { x: 0.38, y: 0.13, w: 0.34, h: 0.44 });
});

// ── 제품 화면 배선(소스 검사) ──

test('제품 화면: 표본마다 정지 화면을 추적하고, 전환 후보 판정·같은 슬라이드 화면 변화 때 나타난 그림을 기억한다', () => {
  const source = readSource('src/renderer/app/main.js');
  assert.match(source, /const appearanceTracker = createAppearanceTracker\(\);/);
  assert.match(readFunctionBody(source, 'function samplePointingFrame('),
    /pointingLocator\.sample\(\{ imageData, ts \}\);\n {2}appearanceTracker\.sample\(\{\s*imageData, ts, excludedCellMask: pointingLocator\.findConstantChangeCells\(\{ nowTs: ts \}\),?\s*\}\);/);
  const confirmBody = readFunctionBody(source, 'async function confirmSlideCandidate(');
  const rememberAt = confirmBody.indexOf('rememberAppearance({ slideLabel: decision.label });');
  assert.ok(rememberAt >= 0, '전환 후보 판정 때 기억');
  assert.ok(rememberAt < confirmBody.indexOf('if (decision.isSameSlide)'), '같은 슬라이드 판정이어도 기억');
  assert.ok(rememberAt < confirmBody.indexOf('pointingLocator.resetChangeHistory();'), '늘 변하는 칸 기록을 비우기 전');
  assert.match(readFunctionBody(source, 'function sampleScreenChange('),
    /if \(result\.event\) \{\n {4}rememberAppearance\(\{ slideLabel \}\);/);
});

test('제품 화면: 지시 발화 영역은 순서 함수로 고르고, 나타난 그림을 붙이면 흐름 창에 남긴다', () => {
  const source = readSource('src/renderer/app/main.js');
  const body = readFunctionBody(source, 'function resolveDeixisPointing(');
  assert.match(body, /pickDeixisRegion\(\{/);
  assert.match(body, /recalledPointing: recentPointingMemory\.recall\(\{ eventWallTs, slideLabel \}\)/);
  assert.match(body, /appearedRegion: appearanceTracker\.recall\(\{ eventWallTs, slideLabel \}\)/);
  assert.match(body, /DEIXIS_REGION_SOURCE_MAP\.appeared/);
  assert.match(body, /return \{ region: picked\.region, pointingOrderHint: picked\.pointingOrderHint \};/);
});

test('제품 화면: 지시 판정 자르기는 main 에 보내는 비율 상자와 같은 여백을 쓴다', () => {
  const source = readSource('src/renderer/app/main.js');
  assert.match(readFunctionBody(source, 'function narrowToPointingRegion('),
    /const rect = toPointingRect\(\{ subRegion: sub, margin: POINTING_CROP_MARGIN \}\);/);
});

test('제품 화면: 가리킴 기억을 지우는 곳(공유 화면 변경·재개·시작·정리)에서 나타난 그림 추적도 지운다', () => {
  const source = readSource('src/renderer/app/main.js');
  const resetCount = (source.match(/recentPointingMemory\.reset\(\);/g) || []).length;
  const pairCount = (source.match(/recentPointingMemory\.reset\(\);\s*appearanceTracker\.reset\(\);/g) || []).length;
  assert.ok(resetCount >= 4);
  assert.equal(pairCount, resetCount);
});

// "이거 아닙니까?"라고 말한 뒤 그림을 붙여 넣으면 트리거 때는 아직 앞 화면이다. 판정할 때 트리거 뒤에 나타난 그림을 대상으로 쓴다.
test('트리거 뒤에 같은 화면에 나타난 그림만 돌려준다(트리거 전에 나타났거나 다른 슬라이드면 없음)', () => {
  const tracker = createAppearanceTracker();
  const feeder = createFeeder(tracker);
  feeder.feed([TITLE], 4);
  feeder.feed([TITLE, PICTURE_LEFT], 4);
  tracker.capture({ slideLabel: '3', wallTs: START_WALL_TS, nowTs: feeder.nowTs() });
  const region = tracker.recallAfter({ sinceWallTs: START_WALL_TS - 1500, slideLabel: '3' });
  assertSameRect(region, blockRect(PICTURE_LEFT));
  assert.equal(region.kind, APPEARED_REGION_KIND);
  assert.equal(tracker.recallAfter({ sinceWallTs: START_WALL_TS + 1, slideLabel: '3' }), null, '트리거보다 먼저 나타난 그림');
  assert.equal(tracker.recallAfter({ sinceWallTs: START_WALL_TS - 1500, slideLabel: '2' }), null, '다른 슬라이드');
  assert.equal(tracker.recallAfter({ sinceWallTs: Number.NaN, slideLabel: '3' }), null);
});

test('연결: 지시 판정은 트리거 말 뒤에 나타난 그림이 있으면 그 영역으로 찍고 pointingRect 로 보낸다', () => {
  const source = fs.readFileSync(new URL('../src/renderer/app/main.js', import.meta.url), 'utf8');
  assert.match(source, /appearanceTracker\.recallAfter\(\{ sinceWallTs: triggerWallTs, slideLabel \}\)/);
  assert.match(source, /const decisionRegion = resolveDecisionRegion\(firedDecision\);/);
});
