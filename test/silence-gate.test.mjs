import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createSilenceNarrationGate, SILENCE_GATE_REASON_MAP, SILENCE_MIN_INTERVAL_MS,
} = require('../src/main/caption-pipeline/orchestrator/silence-gate.js');

function createClock(startMs = 100000) {
  let nowMs = startMs;
  return { now: () => nowMs, advance: (ms) => { nowMs += ms; } };
}

test('처음 무음은 허용하고 반납용 표를 준다', () => {
  const gate = createSilenceNarrationGate({ now: createClock().now });
  const acquired = gate.tryAcquire({ slideLabel: '1' });
  assert.equal(acquired.isAllowed, true);
  assert.equal(acquired.reason, null);
  assert.ok(acquired.ticket);
});

test('처리 중이면 다음 무음은 막는다', () => {
  const gate = createSilenceNarrationGate({ now: createClock().now });
  gate.tryAcquire({ slideLabel: '1' });
  assert.deepEqual(gate.tryAcquire({ slideLabel: '2' }), {
    isAllowed: false, reason: SILENCE_GATE_REASON_MAP.inFlight, ticket: null,
  });
});

test('같은 슬라이드에서 이미 해설을 냈으면 막는다', () => {
  const clock = createClock();
  const gate = createSilenceNarrationGate({ now: clock.now });
  const { ticket } = gate.tryAcquire({ slideLabel: '1' });
  gate.release({ ticket, slideLabel: '1', isEmitted: true });
  clock.advance(SILENCE_MIN_INTERVAL_MS * 3);
  assert.deepEqual(gate.tryAcquire({ slideLabel: '1' }), {
    isAllowed: false, reason: SILENCE_GATE_REASON_MAP.slideDone, ticket: null,
  });
});

test('해설을 내면 1분 동안은 다른 슬라이드도 막는다', () => {
  const clock = createClock();
  const gate = createSilenceNarrationGate({ now: clock.now });
  assert.equal(SILENCE_MIN_INTERVAL_MS, 60000);
  const { ticket } = gate.tryAcquire({ slideLabel: '1' });
  gate.release({ ticket, slideLabel: '1', isEmitted: true });
  clock.advance(SILENCE_MIN_INTERVAL_MS - 1);
  assert.deepEqual(gate.tryAcquire({ slideLabel: '2' }), {
    isAllowed: false, reason: SILENCE_GATE_REASON_MAP.minuteCap, ticket: null,
  });
  clock.advance(1);
  assert.equal(gate.tryAcquire({ slideLabel: '2' }).isAllowed, true);
});

test('해설을 내지 못했으면 같은 슬라이드의 다음 무음을 허용한다', () => {
  const gate = createSilenceNarrationGate({ now: createClock().now });
  const { ticket } = gate.tryAcquire({ slideLabel: '1' });
  gate.release({ ticket, slideLabel: '1', isEmitted: false });
  assert.equal(gate.tryAcquire({ slideLabel: '1' }).isAllowed, true);
});

test('reset 하면 슬라이드·분당 기록과 처리 중 표시를 모두 지운다', () => {
  const gate = createSilenceNarrationGate({ now: createClock().now });
  const { ticket } = gate.tryAcquire({ slideLabel: '1' });
  gate.release({ ticket, slideLabel: '1', isEmitted: true });
  gate.tryAcquire({ slideLabel: '2' });
  gate.reset();
  assert.equal(gate.tryAcquire({ slideLabel: '1' }).isAllowed, true);
});

test('reset 이전에 받은 표로 반납하면 무시한다', () => {
  const gate = createSilenceNarrationGate({ now: createClock().now });
  const stale = gate.tryAcquire({ slideLabel: '1' });
  gate.reset();
  const current = gate.tryAcquire({ slideLabel: '2' });
  gate.release({ ticket: stale.ticket, slideLabel: '1', isEmitted: true });
  assert.equal(gate.tryAcquire({ slideLabel: '3' }).reason, SILENCE_GATE_REASON_MAP.inFlight);
  gate.release({ ticket: current.ticket, slideLabel: '2', isEmitted: false });
  assert.equal(gate.tryAcquire({ slideLabel: '1' }).isAllowed, true);
});
