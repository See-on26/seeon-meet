import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isImmediateCaption, NarrationHoldGate } from '../src/renderer/core/audio-renderer/narration-entry.js';

test('사용자 명령 답만 즉시 재생한다', () => {
  assert.equal(isImmediateCaption({ narrationClass: 'user_command' }), true);
  assert.equal(isImmediateCaption({ narrationClass: 'deixis' }), false);
  assert.equal(isImmediateCaption(null), false);
});

test('보류 중이 아니면 바로 넘긴다', () => {
  const deliveredList = [];
  const gate = new NarrationHoldGate({ deliver: (wav) => deliveredList.push(wav) });
  assert.equal(gate.submit('a'), true);
  assert.deepEqual(deliveredList, ['a']);
});

test('보류 중 들어온 해설은 모았다가 풀 때 순서대로 넘긴다', () => {
  const deliveredList = [];
  const gate = new NarrationHoldGate({ deliver: (wav) => deliveredList.push(wav) });
  gate.hold();
  assert.equal(gate.submit('a'), false);
  gate.submit('b');
  assert.deepEqual(deliveredList, []);
  assert.equal(gate.release(), 2);
  assert.deepEqual(deliveredList, ['a', 'b']);
  assert.equal(gate.isHeld, false);
});

test('clear 는 모은 해설을 버리고 보류를 푼다', () => {
  const deliveredList = [];
  const gate = new NarrationHoldGate({ deliver: (wav) => deliveredList.push(wav) });
  gate.hold();
  gate.submit('a');
  gate.clear();
  assert.equal(gate.release(), 0);
  assert.deepEqual(deliveredList, []);
});
