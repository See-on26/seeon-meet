import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isMicToggleInput, readCommandFromInput } = require('../src/main/shortcut.js');

test('Ctrl/Cmd+8 은 마이크 토글이다', () => {
  assert.equal(isMicToggleInput({ input: { type: 'keyDown', key: '8', control: true } }), true);
  assert.equal(isMicToggleInput({ input: { type: 'keyDown', key: '8', meta: true } }), true);
  assert.equal(isMicToggleInput({ input: { type: 'keyDown', key: '8' } }), false);
  assert.equal(isMicToggleInput({ input: { type: 'keyUp', key: '8', control: true } }), false);
  assert.equal(isMicToggleInput({ input: { type: 'keyDown', key: '8', control: true, shift: true } }), false);
});

test('Ctrl+8 은 프리셋 명령이 아니다', () => {
  assert.equal(readCommandFromInput({ input: { type: 'keyDown', key: '8', control: true } }), null);
});
