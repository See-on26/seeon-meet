import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeViewBoundsPair, computeToggledWindowBounds, VIEWER_PANEL_WIDTH_MAP,
} = require('../src/main/viewer-panel-layout.js');

const WORK_AREA = { x: 0, y: 25, width: 1728, height: 1080 };

test('펼친 패널은 600px, Meet 는 나머지 폭이다', () => {
  const { meetBounds, viewerBounds } = computeViewBoundsPair({ contentWidth: 1600, contentHeight: 900, isCollapsed: false });
  assert.deepEqual(meetBounds, { x: 0, y: 0, width: 1000, height: 900 });
  assert.deepEqual(viewerBounds, { x: 1000, y: 0, width: 600, height: 900 });
});

test('접은 패널은 48px 띠만 남는다', () => {
  const { meetBounds, viewerBounds } = computeViewBoundsPair({ contentWidth: 1048, contentHeight: 900, isCollapsed: true });
  assert.deepEqual(meetBounds, { x: 0, y: 0, width: 1000, height: 900 });
  assert.deepEqual(viewerBounds, { x: 1000, y: 0, width: 48, height: 900 });
});

test('창이 패널보다 좁으면 패널이 창 폭을 넘지 않는다', () => {
  const { meetBounds, viewerBounds } = computeViewBoundsPair({ contentWidth: 500, contentHeight: 600, isCollapsed: false });
  assert.equal(meetBounds.width, 0);
  assert.deepEqual(viewerBounds, { x: 0, y: 0, width: 500, height: 600 });
});

test('접으면 창 왼쪽 끝은 그대로 두고 패널 폭 차이만큼 창을 줄인다', () => {
  const windowBounds = { x: 100, y: 50, width: 1600, height: 900 };
  assert.deepEqual(
    computeToggledWindowBounds({ windowBounds, workArea: WORK_AREA, isCollapsed: true }),
    { x: 100, y: 50, width: 1048, height: 900 },
  );
});

test('접었다 펴도 Meet 화면 폭이 그대로다', () => {
  const expandedWindow = { x: 100, y: 50, width: 1600, height: 900 };
  const collapsedWindow = computeToggledWindowBounds({ windowBounds: expandedWindow, workArea: WORK_AREA, isCollapsed: true });
  const reexpandedWindow = computeToggledWindowBounds({ windowBounds: collapsedWindow, workArea: WORK_AREA, isCollapsed: false });
  const meetWidthOf = ({ width }, isCollapsed) =>
    computeViewBoundsPair({ contentWidth: width, contentHeight: 900, isCollapsed }).meetBounds.width;

  assert.equal(meetWidthOf(collapsedWindow, true), meetWidthOf(expandedWindow, false));
  assert.deepEqual(reexpandedWindow, expandedWindow);
});

test('펼칠 때 화면 오른쪽 끝을 넘으면 창을 왼쪽으로 옮긴다', () => {
  const windowBounds = { x: 1000, y: 50, width: 700, height: 900 };
  assert.deepEqual(
    computeToggledWindowBounds({ windowBounds, workArea: WORK_AREA, isCollapsed: false }),
    { x: 476, y: 50, width: 1252, height: 900 },
  );
});

test('펼칠 창이 화면보다 넓으면 화면 폭에 맞춘다', () => {
  const windowBounds = { x: 0, y: 50, width: 1200, height: 900 };
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  assert.deepEqual(
    computeToggledWindowBounds({ windowBounds, workArea, isCollapsed: false }),
    { x: 0, y: 50, width: 1440, height: 900 },
  );
});

test('보조 모니터처럼 화면 시작점이 0 이 아니어도 그 화면 안에 맞춘다', () => {
  const windowBounds = { x: 3000, y: 50, width: 700, height: 900 };
  const workArea = { x: 1728, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(
    computeToggledWindowBounds({ windowBounds, workArea, isCollapsed: false }),
    { x: 2396, y: 50, width: 1252, height: 900 },
  );
});

test('아주 좁은 창을 접어도 띠 폭보다 좁아지지 않는다', () => {
  const windowBounds = { x: 0, y: 0, width: 500, height: 600 };
  const { width } = computeToggledWindowBounds({ windowBounds, workArea: WORK_AREA, isCollapsed: true });
  assert.equal(width, VIEWER_PANEL_WIDTH_MAP.collapsed);
});
