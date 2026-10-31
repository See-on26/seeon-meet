import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPendingEvidence } = require('../src/main/caption-pipeline/orchestrator/pending-evidence.js');

function createClock(startMs = 0) {
  let nowMs = startMs;
  return { now: () => nowMs, set: (ms) => { nowMs = ms; } };
}

function note({ ts = 0, captureTs = -500, slideLabel = '2', rejectKind = 'none' } = {}) {
  return { ts, captureTs, slideLabel, rejectKind, narrationType: 'interpretation', subKind: 'claim_to_value' };
}

test('슬라이드 2 NONE 뒤 5초에 슬라이드 2 변화가 오면 꺼내고, 다시 꺼내면 없다', () => {
  const clock = createClock(0);
  const evidence = createPendingEvidence({ now: clock.now });
  assert.equal(evidence.noteUnresolved(note()), true);
  clock.set(5000);
  const taken = evidence.takeForChange({ slideLabel: '2', changeTs: 4600 });
  assert.equal(taken?.ts, 0);
  assert.equal(evidence.takeForChange({ slideLabel: '2', changeTs: 4600 }), null);
});

test('10초가 지난 변화와는 짝짓지 않는다', () => {
  const clock = createClock(0);
  const evidence = createPendingEvidence({ now: clock.now });
  evidence.noteUnresolved(note());
  clock.set(11000);
  assert.equal(evidence.takeForChange({ slideLabel: '2', changeTs: 11000 }), null);
});

test('같은 슬라이드 변화는 같은 슬라이드만, 다음 슬라이드 기준 화면은 트리거 뒤에 바뀐 슬라이드만 짝짓는다', () => {
  const clock = createClock(0);
  const evidence = createPendingEvidence({ now: clock.now });
  evidence.noteUnresolved(note());
  clock.set(4000);
  assert.equal(evidence.takeForChange({ slideLabel: '3', changeTs: 3500 }), null);
  assert.equal(evidence.takeForSlideStart({ slideLabel: '2', slideStartTs: 1000, baselineTs: 5000 }), null);
  assert.equal(evidence.takeForSlideStart({ slideLabel: '3', slideStartTs: -900, baselineTs: 3100 }), null);
  clock.set(6000);
  const taken = evidence.takeForSlideStart({ slideLabel: '3', slideStartTs: 1500, baselineTs: 5500 });
  assert.equal(taken?.slideLabel, '2');
});

test('보관한 변화가 트리거 캡처 뒤면 늦게 온 미해결 결과와 짝짓고, 캡처 전이면 짝짓지 않는다', () => {
  const clock = createClock(1000);
  const evidence = createPendingEvidence({ now: clock.now });
  evidence.rememberChange({ slideLabel: '2', changeTs: 1000, frame: { lineList: [] }, isRetryEligible: true });
  clock.set(3000);
  assert.equal(evidence.findChangeAfter({ slideLabel: '2', captureTs: 1500 }), null);
  const paired = evidence.findChangeAfter({ slideLabel: '2', captureTs: 500 });
  assert.equal(paired?.changeTs, 1000);
  assert.equal(evidence.findChangeAfter({ slideLabel: '2', captureTs: 500 }), null);
});

test('E1 해설을 이미 냈거나 거르기에서 빠진 변화는 늦은 결과와 짝짓지 않는다', () => {
  const clock = createClock(1000);
  const evidence = createPendingEvidence({ now: clock.now });
  evidence.rememberChange({ slideLabel: '2', changeTs: 1000, frame: {}, isRetryEligible: false });
  clock.set(2000);
  assert.equal(evidence.findChangeAfter({ slideLabel: '2', captureTs: 500 }), null);
});

test('형식 오류·한자 거절은 적지 않는다', () => {
  const evidence = createPendingEvidence({ now: () => 0 });
  assert.equal(evidence.noteUnresolved(note({ rejectKind: 'format' })), false);
  assert.equal(evidence.noteUnresolved(note({ rejectKind: 'han' })), false);
  assert.equal(evidence.takeForChange({ slideLabel: '2', changeTs: 100 }), null);
});

test('값 없음 결과는 적고, peek 는 꺼내지 않는다', () => {
  const clock = createClock(0);
  const evidence = createPendingEvidence({ now: clock.now });
  assert.equal(evidence.noteUnresolved({ ...note(), rejectKind: null, unresolvedReason: 'value_absent' }), true);
  clock.set(2000);
  assert.ok(evidence.peekForChange({ slideLabel: '2', changeTs: 1500 }));
  assert.ok(evidence.takeForChange({ slideLabel: '2', changeTs: 1500 }));
});
