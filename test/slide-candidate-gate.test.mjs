import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlideCandidateGate } from '../src/renderer/core/trigger/slide-candidate-gate.js';

const STILL = { isTransition: false, isFirst: false };
const FIRST = { isTransition: false, isFirst: true };
const TRANSITION = { isTransition: true, isFirst: false };

test('화면 공유 영역이 바뀐 직후(억제 구간)의 첫 장 표시는 버리지 않고, 억제가 끝나면 지금 화면을 첫 장으로 확정한다', () => {
  const gate = createSlideCandidateGate();
  assert.deepEqual(gate.decide({ verdict: FIRST, ts: 1000, suppressUntil: 2500, isConfirming: false }), { shouldConfirm: false, isFirst: false });
  assert.deepEqual(gate.decide({ verdict: STILL, ts: 2000, suppressUntil: 2500, isConfirming: false }), { shouldConfirm: false, isFirst: false });
  assert.deepEqual(gate.decide({ verdict: STILL, ts: 2600, suppressUntil: 2500, isConfirming: false }), { shouldConfirm: true, isFirst: true });
  assert.deepEqual(gate.decide({ verdict: STILL, ts: 2700, suppressUntil: 2500, isConfirming: false }), { shouldConfirm: false, isFirst: false }, '첫 장은 한 번만 확정한다');
});

test('억제 구간이 없으면 첫 장 표시를 바로 확정한다', () => {
  const gate = createSlideCandidateGate();
  assert.deepEqual(gate.decide({ verdict: FIRST, ts: 100, suppressUntil: 0, isConfirming: false }), { shouldConfirm: true, isFirst: true });
});

test('억제가 끝난 뒤 전환이 오면 전환으로 확정하고 기다리던 첫 장은 지운다', () => {
  const gate = createSlideCandidateGate();
  gate.decide({ verdict: FIRST, ts: 1000, suppressUntil: 2500, isConfirming: false });
  assert.deepEqual(gate.decide({ verdict: TRANSITION, ts: 2600, suppressUntil: 2500, isConfirming: false }), { shouldConfirm: true, isFirst: false });
  assert.deepEqual(gate.decide({ verdict: STILL, ts: 2700, suppressUntil: 2500, isConfirming: false }), { shouldConfirm: false, isFirst: false });
});

test('억제 구간 안의 전환은 지금처럼 확정하지 않는다', () => {
  const gate = createSlideCandidateGate();
  assert.deepEqual(gate.decide({ verdict: TRANSITION, ts: 1000, suppressUntil: 2500, isConfirming: false }), { shouldConfirm: false, isFirst: false });
});

test('다른 확정이 진행 중이면 첫 장은 기다렸다가 끝난 뒤 확정한다', () => {
  const gate = createSlideCandidateGate();
  assert.deepEqual(gate.decide({ verdict: FIRST, ts: 3000, suppressUntil: 0, isConfirming: true }), { shouldConfirm: false, isFirst: false });
  assert.deepEqual(gate.decide({ verdict: STILL, ts: 3100, suppressUntil: 0, isConfirming: false }), { shouldConfirm: true, isFirst: true });
});

test('reset 하면 기다리던 첫 장을 지운다', () => {
  const gate = createSlideCandidateGate();
  gate.decide({ verdict: FIRST, ts: 1000, suppressUntil: 2500, isConfirming: false });
  gate.reset();
  assert.deepEqual(gate.decide({ verdict: STILL, ts: 2600, suppressUntil: 2500, isConfirming: false }), { shouldConfirm: false, isFirst: false });
});
