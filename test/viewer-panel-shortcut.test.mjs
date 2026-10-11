import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isViewerPanelToggleInput, readCommandFromInput, isSummaryToggleInput } = require('../src/main/shortcut.js');
const { buildAppMenuTemplate, VIEWER_PANEL_TOGGLE_ACCELERATOR } = require('../src/main/app-menu.js');

test('Ctrl/Cmd+9 는 패널 접기·펼치기다', () => {
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: '9', control: true } }), true);
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: '9', meta: true } }), true);
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: '9' } }), false);
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyUp', key: '9', control: true } }), false);
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: '9', control: true, shift: true } }), false);
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: '9', control: true, alt: true } }), false);
});

test('키를 누르고 있을 때의 자동 반복은 패널 토글로 보지 않는다', () => {
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: '9', control: true, isAutoRepeat: true } }), false);
});

test('Ctrl+9 는 프리셋 명령·요약 토글이 아니다', () => {
  const input = { type: 'keyDown', key: '9', control: true };
  assert.equal(readCommandFromInput({ input }), null);
  assert.equal(isSummaryToggleInput({ input }), false);
});

test('보기 메뉴의 패널 항목은 단축키를 표시만 하고 따로 등록하지 않는다', () => {
  let toggleCount = 0;
  const template = buildAppMenuTemplate({
    onReloadMeet: () => {}, onToggleViewerPanel: () => { toggleCount += 1; }, platform: 'win32',
  });
  const viewMenu = template.find((menu) => menu.label === '보기');
  const panelItem = viewMenu.submenu.find((item) => item.accelerator === VIEWER_PANEL_TOGGLE_ACCELERATOR);

  assert.ok(panelItem);
  assert.equal(panelItem.registerAccelerator, false);
  panelItem.click();
  assert.equal(toggleCount, 1);
});
