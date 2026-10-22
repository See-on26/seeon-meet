import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createScreenChangeGate, SCREEN_CHANGE_GATE_REASON_MAP,
} = require('../src/main/caption-pipeline/orchestrator/screen-change-gate.js');

test('처음은 허가하고, 처리 중에 다시 오면 in_flight 로 막는다', () => {
  const gate = createScreenChangeGate();
  const first = gate.tryAcquire({ slideLabel: '1' });
  assert.equal(first.isAllowed, true);
  const second = gate.tryAcquire({ slideLabel: '1' });
  assert.deepEqual([second.isAllowed, second.reason], [false, SCREEN_CHANGE_GATE_REASON_MAP.inFlight]);
  gate.release({ ticket: first.ticket, slideLabel: '1', isEmitted: false });
  assert.equal(gate.tryAcquire({ slideLabel: '1' }).isAllowed, true);
});

test('슬라이드 3에서 두 번 내면 슬라이드 3은 slide_cap, 슬라이드 4는 허가한다', () => {
  const gate = createScreenChangeGate({ perSlideMax: 2 });
  for (let i = 0; i < 2; i += 1) {
    const acquired = gate.tryAcquire({ slideLabel: '3' });
    gate.release({ ticket: acquired.ticket, slideLabel: '3', isEmitted: true });
  }
  const capped = gate.tryAcquire({ slideLabel: '3' });
  assert.deepEqual([capped.isAllowed, capped.reason], [false, SCREEN_CHANGE_GATE_REASON_MAP.slideCap]);
  assert.equal(gate.tryAcquire({ slideLabel: '4' }).isAllowed, true);
});

test('내지 못하고 반납하면 횟수를 세지 않는다', () => {
  const gate = createScreenChangeGate({ perSlideMax: 1 });
  const acquired = gate.tryAcquire({ slideLabel: '2' });
  gate.release({ ticket: acquired.ticket, slideLabel: '2', isEmitted: false });
  assert.equal(gate.countOf({ slideLabel: '2' }), 0);
  assert.equal(gate.tryAcquire({ slideLabel: '2' }).isAllowed, true);
});

test('revert 하면 그 슬라이드 횟수가 줄어 다시 낼 수 있다', () => {
  const gate = createScreenChangeGate({ perSlideMax: 1 });
  const acquired = gate.tryAcquire({ slideLabel: '5' });
  gate.release({ ticket: acquired.ticket, slideLabel: '5', isEmitted: true });
  assert.equal(gate.tryAcquire({ slideLabel: '5' }).reason, SCREEN_CHANGE_GATE_REASON_MAP.slideCap);
  assert.equal(gate.revert({ slideLabel: '5' }), true);
  assert.equal(gate.countOf({ slideLabel: '5' }), 0);
  assert.equal(gate.tryAcquire({ slideLabel: '5' }).isAllowed, true);
});

test('reset 뒤에 옛 표로 반납하면 무시한다', () => {
  const gate = createScreenChangeGate();
  const acquired = gate.tryAcquire({ slideLabel: '1' });
  gate.reset();
  const fresh = gate.tryAcquire({ slideLabel: '1' });
  gate.release({ ticket: acquired.ticket, slideLabel: '1', isEmitted: true });
  assert.equal(gate.countOf({ slideLabel: '1' }), 0);
  assert.equal(gate.tryAcquire({ slideLabel: '1' }).reason, SCREEN_CHANGE_GATE_REASON_MAP.inFlight);
  gate.release({ ticket: fresh.ticket, slideLabel: '1', isEmitted: true });
  assert.equal(gate.countOf({ slideLabel: '1' }), 1);
});

test('슬라이드 라벨은 major 로 센다("3-2" 는 3)', () => {
  const gate = createScreenChangeGate({ perSlideMax: 1 });
  const acquired = gate.tryAcquire({ slideLabel: '3' });
  gate.release({ ticket: acquired.ticket, slideLabel: '3', isEmitted: true });
  assert.equal(gate.tryAcquire({ slideLabel: '3-2' }).reason, SCREEN_CHANGE_GATE_REASON_MAP.slideCap);
});
