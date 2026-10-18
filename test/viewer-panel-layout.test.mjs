import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeViewBoundsPair, computeToggledWindowBounds, createMeetResizeNotifier, VIEWER_PANEL_WIDTH_MAP,
} = require('../src/main/viewer-panel-layout.js');

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function readFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} 없음`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end);
}

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

test('Meet 화면 크기가 바뀔 때만 새 크기를 알리고, 처음 배치는 비교할 크기가 없어 알리지 않는다', () => {
  const sentList = [];
  const notifier = createMeetResizeNotifier({ notify: (size) => sentList.push(size) });
  notifier.observe({ x: 0, y: 0, width: 912, height: 842 });
  assert.deepEqual(sentList, []);
  notifier.observe({ x: 0, y: 0, width: 912, height: 842 });
  assert.deepEqual(sentList, [], '같은 크기로 다시 배치하면(창 이동 등) 알리지 않는다');
  notifier.observe({ x: 0, y: 0, width: 1464, height: 842 });
  notifier.observe({ x: 0, y: 0, width: 1464, height: 949 });
  assert.deepEqual(sentList, [{ width: 1464, height: 842 }, { width: 1464, height: 949 }]);
});

test('창을 닫고 다시 만들면 첫 배치로 보고 알리지 않는다', () => {
  const sentList = [];
  const notifier = createMeetResizeNotifier({ notify: (size) => sentList.push(size) });
  notifier.observe({ width: 912, height: 842 });
  notifier.reset();
  notifier.observe({ width: 1000, height: 900 });
  assert.deepEqual(sentList, []);
});

test('layoutView 는 Meet 크기를 바꾸기 전에 뷰어에 meet-view-resized 로 새 크기를 알린다', () => {
  const source = readSource('src/main/window.js');
  const body = readFunctionBody(source, 'layoutView');
  const notifyIndex = body.indexOf('meetResizeNotifier.observe(meetBounds)');
  assert.ok(notifyIndex >= 0);
  assert.ok(notifyIndex < body.indexOf('meetView.setBounds(meetBounds)'));
  assert.match(source, /webContents\.send\('meet-view-resized', \{ width, height \}\)/);
  assert.match(source, /meetResizeNotifier\.reset\(\)/);
});
