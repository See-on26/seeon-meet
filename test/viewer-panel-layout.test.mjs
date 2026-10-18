import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeViewBoundsPair, createMeetResizeNotifier, VIEWER_PANEL_WIDTH_MAP,
} = require('../src/main/viewer-panel-layout.js');

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function readFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} 없음`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end);
}

test('펼친 패널은 600px, Meet 는 나머지 폭이다', () => {
  const { meetBounds, viewerBounds } = computeViewBoundsPair({ contentWidth: 1600, contentHeight: 900, isCollapsed: false });
  assert.deepEqual(meetBounds, { x: 0, y: 0, width: 1000, height: 900 });
  assert.deepEqual(viewerBounds, { x: 1000, y: 0, width: 600, height: 900 });
});

test('접은 패널은 48px 띠만 남고, Meet 는 창 폭에서 띠를 뺀 나머지를 모두 쓴다', () => {
  const { meetBounds, viewerBounds } = computeViewBoundsPair({ contentWidth: 1600, contentHeight: 900, isCollapsed: true });
  assert.deepEqual(meetBounds, { x: 0, y: 0, width: 1552, height: 900 });
  assert.deepEqual(viewerBounds, { x: 1552, y: 0, width: 48, height: 900 });
});

test('창 폭이 그대로면 접을 때 Meet 폭은 패널이 비운 552px 만큼 늘고, 펴면 원래대로 준다(보통 창·최대화·전체 화면 모두)', () => {
  const widthDelta = VIEWER_PANEL_WIDTH_MAP.expanded - VIEWER_PANEL_WIDTH_MAP.collapsed;
  assert.equal(widthDelta, 552);
  for (const contentWidth of [1600, 1512, 1728, 2560]) {
    const meetWidthOf = (isCollapsed) =>
      computeViewBoundsPair({ contentWidth, contentHeight: 900, isCollapsed }).meetBounds.width;
    assert.equal(meetWidthOf(false), contentWidth - VIEWER_PANEL_WIDTH_MAP.expanded, `${contentWidth} 펼침`);
    assert.equal(meetWidthOf(true), contentWidth - VIEWER_PANEL_WIDTH_MAP.collapsed, `${contentWidth} 접힘`);
    assert.equal(meetWidthOf(true) - meetWidthOf(false), widthDelta, `${contentWidth}`);
  }
});

test('창이 패널보다 좁으면 패널이 창 폭을 넘지 않는다', () => {
  const { meetBounds, viewerBounds } = computeViewBoundsPair({ contentWidth: 500, contentHeight: 600, isCollapsed: false });
  assert.equal(meetBounds.width, 0);
  assert.deepEqual(viewerBounds, { x: 0, y: 0, width: 500, height: 600 });
});

test('좁은 창: 펼친 패널 폭과 같으면 Meet 은 0 이고, 접으면 띠를 뺀 폭이 Meet 이 된다', () => {
  const expanded = computeViewBoundsPair({ contentWidth: 600, contentHeight: 600, isCollapsed: false });
  assert.equal(expanded.meetBounds.width, 0);
  assert.deepEqual(expanded.viewerBounds, { x: 0, y: 0, width: 600, height: 600 });
  const collapsed = computeViewBoundsPair({ contentWidth: 600, contentHeight: 600, isCollapsed: true });
  assert.deepEqual(collapsed.meetBounds, { x: 0, y: 0, width: 552, height: 600 });
  assert.deepEqual(collapsed.viewerBounds, { x: 552, y: 0, width: 48, height: 600 });
});

test('좁은 창: 띠보다 좁으면 접어도 띠가 창 폭을 넘지 않고 Meet 은 0 이다', () => {
  for (const contentWidth of [48, 30]) {
    const { meetBounds, viewerBounds } = computeViewBoundsPair({ contentWidth, contentHeight: 600, isCollapsed: true });
    assert.equal(meetBounds.width, 0, `${contentWidth}`);
    assert.deepEqual(viewerBounds, { x: 0, y: 0, width: contentWidth, height: 600 });
  }
});

test('패널을 접고 펴도 창 크기·최대화는 건드리지 않고 화면 배치만 다시 한다', () => {
  const source = readSource('src/main/window.js');
  const body = readFunctionBody(source, 'setViewerCollapsed');
  assert.doesNotMatch(body, /win\.setBounds|unmaximize|getDisplayMatching/);
  assert.match(body, /layoutView\(\);/);
  assert.doesNotMatch(source, /computeToggledWindowBounds/);
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
