import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isMicToggleInput, readQuestionPresetSlot } = require('../src/main/shortcut.js');

test('Ctrl+M 은 마이크 토글이다', () => {
  assert.equal(isMicToggleInput({ input: { type: 'keyDown', key: 'm', code: 'KeyM', control: true } }), true);
  assert.equal(isMicToggleInput({ input: { type: 'keyDown', key: 'm', code: 'KeyM' } }), false);
  assert.equal(isMicToggleInput({ input: { type: 'keyUp', key: 'm', code: 'KeyM', control: true } }), false);
  assert.equal(isMicToggleInput({ input: { type: 'keyDown', key: 'M', code: 'KeyM', control: true, shift: true } }), false);
  assert.equal(isMicToggleInput({ input: { type: 'keyDown', key: 'm', code: 'KeyM', control: true, alt: true } }), false);
});

test('한글 입력 상태에서도 자판 위치로 Ctrl+M 을 읽는다', () => {
  assert.equal(isMicToggleInput({ input: { type: 'keyDown', key: 'ㅡ', code: 'KeyM', control: true } }), true);
});

test('맥의 Cmd+M(최소화)은 마이크 토글로 가로채지 않는다', () => {
  assert.equal(isMicToggleInput({ input: { type: 'keyDown', key: 'm', code: 'KeyM', meta: true } }), false);
});

test('Ctrl+8 은 이제 마이크가 아니라 질문 프리셋 8번이다', () => {
  const input = { type: 'keyDown', key: '8', code: 'Digit8', control: true };
  assert.equal(isMicToggleInput({ input }), false);
  assert.equal(readQuestionPresetSlot({ input }), 8);
});

test('키를 누르고 있을 때의 자동 반복은 토글로 보지 않는다', () => {
  assert.equal(isMicToggleInput({ input: { type: 'keyDown', key: 'm', code: 'KeyM', control: true, isAutoRepeat: true } }), false);
});
