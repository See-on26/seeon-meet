import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAnchoredPanelPosition, PANEL_GAP_PX, PANEL_EDGE_MARGIN_PX,
} from '../src/renderer/core/ui/anchored-panel-position.js';

const rect = ({ left, top, width, height }) => ({
  left, top, right: left + width, bottom: top + height, width, height,
});

// 좁은 화면에서 머리줄이 두 줄로 접히면 설정 버튼이 두 번째 줄(y 63~97)로 내려간다.
// 고정 위치(top 54px)로 띄우면 패널이 버튼을 덮어 다시 눌러 닫을 수 없었다.
test('패널은 버튼 바로 아래에 뜬다 — 머리줄이 접혀도 버튼을 덮지 않는다', () => {
  const anchorRect = rect({ left: 557, top: 63, width: 34, height: 34 });
  const position = computeAnchoredPanelPosition({
    anchorRect, viewportWidth: 605, viewportHeight: 845, panelWidth: 300,
  });
  assert.equal(position.top, 97 + PANEL_GAP_PX);
  assert.equal(position.right, 605 - 591);
  assert.ok(position.top > anchorRect.bottom, '패널 위쪽이 버튼 아래쪽보다 아래다');
});

test('한 줄 머리줄이면 버튼 아래 같은 오른쪽 끝에 맞춘다', () => {
  const anchorRect = rect({ left: 720, top: 10, width: 34, height: 34 });
  const position = computeAnchoredPanelPosition({
    anchorRect, viewportWidth: 768, viewportHeight: 900, panelWidth: 300,
  });
  assert.deepEqual([position.top, position.right], [44 + PANEL_GAP_PX, 768 - 754]);
});

test('오른쪽 끝에 붙은 버튼이어도 화면 가장자리 여백은 지킨다', () => {
  const anchorRect = rect({ left: 600, top: 10, width: 30, height: 30 });
  const position = computeAnchoredPanelPosition({
    anchorRect, viewportWidth: 628, viewportHeight: 800, panelWidth: 300,
  });
  assert.equal(position.right, PANEL_EDGE_MARGIN_PX);
});

test('화면이 패널보다 좁으면 왼쪽 밖으로 나가지 않게 오른쪽 거리를 줄인다', () => {
  const anchorRect = rect({ left: 150, top: 60, width: 34, height: 34 });
  const position = computeAnchoredPanelPosition({
    anchorRect, viewportWidth: 320, viewportHeight: 600, panelWidth: 300,
  });
  assert.ok(320 - position.right - 300 >= 0, '패널 왼쪽 끝이 화면 안에 있다');
  assert.ok(position.right >= 0);
});

test('아래로 남은 높이만큼만 펼쳐 화면 밖으로 넘치지 않게 한다', () => {
  const anchorRect = rect({ left: 557, top: 63, width: 34, height: 34 });
  const position = computeAnchoredPanelPosition({
    anchorRect, viewportWidth: 605, viewportHeight: 400, panelWidth: 300,
  });
  assert.equal(position.maxHeight, 400 - (97 + PANEL_GAP_PX) - PANEL_EDGE_MARGIN_PX);
});
