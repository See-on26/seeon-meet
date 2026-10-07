import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isImmediateCaption, isAnchoredCaption, NarrationHoldGate } from '../src/renderer/core/audio-renderer/narration-entry.js';

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

test('무발화 해설은 틈을 다시 고르지 않고 침묵 시점에 끼운다', () => {
  assert.equal(isAnchoredCaption({ narrationClass: 'silence_based' }), true);
  assert.equal(isAnchoredCaption({ narrationClass: 'deixis' }), false);
  assert.equal(isAnchoredCaption(null), false);
});

test('보류는 건 횟수만큼 풀어야 풀린다 — 겹친 질문의 앞 질문이 뒤 질문의 보류를 풀지 않는다', () => {
  const deliveredList = [];
  const gate = new NarrationHoldGate({ deliver: (item) => deliveredList.push(item) });
  gate.hold();
  gate.hold();
  gate.submit('a');
  assert.equal(gate.release(), 0);
  assert.equal(gate.isHeld, true);
  assert.deepEqual(deliveredList, []);
  assert.equal(gate.release(), 1);
  assert.equal(gate.isHeld, false);
  assert.deepEqual(deliveredList, ['a']);
  assert.equal(gate.release(), 0);
  assert.equal(gate.isHeld, false);
});

test('deliverList 가 있으면 모은 해설을 한꺼번에 넘긴다', () => {
  const batchList = [];
  const gate = new NarrationHoldGate({ deliver: () => assert.fail('하나씩 넘기면 안 된다'), deliverList: (list) => batchList.push(list) });
  gate.hold();
  gate.submit('a');
  gate.submit('b');
  gate.release();
  assert.deepEqual(batchList, [['a', 'b']]);
});

test('보류 게이트를 비우면 모아 두던 해설을 돌려준다(재생 못 한 것으로 알리기 위해)', () => {
  const deliveredList = [];
  const gate = new NarrationHoldGate({ deliver: (item) => deliveredList.push(item) });
  gate.hold();
  gate.submit({ text: 'a' });
  gate.submit({ text: 'b' });
  assert.deepEqual(gate.clear().map((item) => item.text), ['a', 'b']);
  assert.equal(gate.isHeld, false);
  assert.deepEqual(deliveredList, []);
});
