import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isViewerPanelToggleInput, readQuestionPresetSlot, isSummaryToggleInput } = require('../src/main/shortcut.js');
const { buildAppMenuTemplate, VIEWER_PANEL_TOGGLE_ACCELERATOR } = require('../src/main/app-menu.js');

test('Ctrl+B 는 패널 접기·펼치기다', () => {
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: 'b', code: 'KeyB', control: true } }), true);
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: 'ㅠ', code: 'KeyB', control: true } }), true);
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: 'b', code: 'KeyB' } }), false);
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: 'b', code: 'KeyB', meta: true } }), false);
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyUp', key: 'b', code: 'KeyB', control: true } }), false);
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: 'B', code: 'KeyB', control: true, shift: true } }), false);
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: 'b', code: 'KeyB', control: true, alt: true } }), false);
});

test('키를 누르고 있을 때의 자동 반복은 패널 토글로 보지 않는다', () => {
  assert.equal(isViewerPanelToggleInput({ input: { type: 'keyDown', key: 'b', code: 'KeyB', control: true, isAutoRepeat: true } }), false);
});

test('Ctrl+9 는 이제 패널이 아니라 질문 프리셋 9번이다', () => {
  const input = { type: 'keyDown', key: '9', code: 'Digit9', control: true };
  assert.equal(isViewerPanelToggleInput({ input }), false);
  assert.equal(readQuestionPresetSlot({ input }), 9);
  assert.equal(isSummaryToggleInput({ input }), false);
});

test('보기 메뉴의 패널 항목은 Ctrl+B 를 표시만 하고 따로 등록하지 않는다', () => {
  let toggleCount = 0;
  const template = buildAppMenuTemplate({
    onReloadMeet: () => {}, onToggleViewerPanel: () => { toggleCount += 1; }, platform: 'win32',
  });
  const viewMenu = template.find((menu) => menu.label === '보기');
  const panelItem = viewMenu.submenu.find((item) => item.accelerator === VIEWER_PANEL_TOGGLE_ACCELERATOR);

  assert.equal(VIEWER_PANEL_TOGGLE_ACCELERATOR, 'Ctrl+B');
  assert.ok(panelItem);
  assert.equal(panelItem.registerAccelerator, false);
  panelItem.click();
  assert.equal(toggleCount, 1);
});

// Electron 기본 창 메뉴는 Windows 에서 최소화 Ctrl+M·닫기 Ctrl+W 를 건다. 마이크·화자 안내 단축키와 겹친다.
test('Windows 메뉴에는 Ctrl+M·Ctrl+W 를 거는 기본 창 메뉴를 두지 않는다', () => {
  const template = buildAppMenuTemplate({ onReloadMeet: () => {}, onToggleViewerPanel: () => {}, platform: 'win32' });
  assert.equal(template.some((menu) => menu.role === 'windowMenu'), false);
  const acceleratorList = template.flatMap((menu) => menu.submenu || []).map((item) => item.accelerator).filter(Boolean);
  assert.equal(acceleratorList.some((accelerator) => /\+(M|W|Q)$/i.test(accelerator)), false);
});

test('맥 메뉴는 Cmd+M·Cmd+W 기본 창 메뉴를 그대로 둔다', () => {
  const template = buildAppMenuTemplate({ onReloadMeet: () => {}, onToggleViewerPanel: () => {}, platform: 'darwin' });
  assert.equal(template.some((menu) => menu.role === 'windowMenu'), true);
});
