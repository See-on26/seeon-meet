import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRoiRelay, ROI_RELAY_MIN_INTERVAL_MS } = require('../src/main/meeting/roi-relay.js');

// 가짜 시계와 타이머. advance 하면 그 사이에 걸린 타이머를 시각 순서대로 부른다.
function makeClock() {
  let nowMs = 1000;
  let timerList = [];
  let nextId = 1;
  const setTimer = (fn, ms) => {
    const id = nextId;
    nextId += 1;
    timerList.push({ id, at: nowMs + ms, fn });
    return id;
  };
  const clearTimer = (id) => { timerList = timerList.filter((timer) => timer.id !== id); };
  const advance = (ms) => {
    const until = nowMs + ms;
    for (;;) {
      const due = timerList.filter((timer) => timer.at <= until).sort((timerA, timerB) => timerA.at - timerB.at)[0];
      if (!due) break;
      timerList = timerList.filter((timer) => timer.id !== due.id);
      nowMs = due.at;
      due.fn();
    }
    nowMs = until;
  };
  // 타이머가 제때 불리지 않은 채(바쁜 이벤트 루프) 시간만 흐르게 한다.
  const skipWithoutTimers = (ms) => { nowMs += ms; };
  return { now: () => nowMs, setTimer, clearTimer, advance, skipWithoutTimers, pendingTimerCount: () => timerList.length };
}

function makeRelay() {
  const clock = makeClock();
  const sentList = [];
  const relay = createRoiRelay({
    send: (payload) => sentList.push({ payload, at: clock.now() }),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  return { clock, sentList, relay };
}

test('간격이 지난 좌표는 바로 보낸다', () => {
  const { clock, sentList, relay } = makeRelay();
  relay.push({ payload: 'a' });
  clock.advance(ROI_RELAY_MIN_INTERVAL_MS);
  relay.push({ payload: 'b' });
  assert.deepEqual(sentList, [{ payload: 'a', at: 1000 }, { payload: 'b', at: 1250 }]);
});

test('간격 안에 들어온 좌표는 다음 좌표를 기다리지 않고 간격이 끝나면 마지막 것을 보낸다', () => {
  const { clock, sentList, relay } = makeRelay();
  relay.push({ payload: 'a' });
  clock.advance(100);
  relay.push({ payload: 'b' });
  clock.advance(50);
  relay.push({ payload: 'c' });
  assert.equal(sentList.length, 1, '간격(250ms) 안에서는 보내지 않는다');
  clock.advance(100);
  assert.deepEqual(sentList, [{ payload: 'a', at: 1000 }, { payload: 'c', at: 1250 }], '창 크기를 바꾼 직후 좌표가 0.5초 늦게 가지 않는다');
  clock.advance(1000);
  assert.equal(sentList.length, 2, '한 번만 보낸다');
});

test('타이머가 늦는 사이 새 좌표가 와서 바로 보냈으면, 걸어 둔 타이머는 지워 두 번 보내지 않는다', () => {
  const { clock, sentList, relay } = makeRelay();
  relay.push({ payload: 'a' });
  clock.advance(100);
  relay.push({ payload: 'b' });
  assert.equal(clock.pendingTimerCount(), 1);
  clock.skipWithoutTimers(200);
  relay.push({ payload: 'c' });
  assert.equal(clock.pendingTimerCount(), 0);
  clock.advance(1000);
  assert.deepEqual(sentList.map(({ payload }) => payload), ['a', 'c']);
});

test('보내는 간격은 여전히 250ms 보다 짧아지지 않는다', () => {
  const { clock, sentList, relay } = makeRelay();
  for (let index = 0; index < 20; index += 1) {
    relay.push({ payload: index });
    clock.advance(50);
  }
  clock.advance(500);
  const gapList = sentList.slice(1).map(({ at }, index) => at - sentList[index].at);
  assert.ok(gapList.every((gapMs) => gapMs >= ROI_RELAY_MIN_INTERVAL_MS), gapList.join(','));
  assert.equal(sentList.at(-1).payload, 19, '마지막 좌표는 빠지지 않는다');
});

test('reset 하면 기다리던 좌표와 타이머를 지운다', () => {
  const { clock, sentList, relay } = makeRelay();
  relay.push({ payload: 'a' });
  clock.advance(100);
  relay.push({ payload: 'b' });
  relay.reset();
  clock.advance(1000);
  assert.deepEqual(sentList.map(({ payload }) => payload), ['a']);
  relay.push({ payload: 'c' });
  assert.deepEqual(sentList.map(({ payload }) => payload), ['a', 'c'], 'reset 뒤 첫 좌표는 바로 보낸다');
});

test('보내다 오류가 나도 다음 좌표는 계속 보낸다', () => {
  const clock = makeClock();
  const sentList = [];
  let isFailing = true;
  const relay = createRoiRelay({
    send: (payload) => { if (isFailing) throw new Error('destroyed'); sentList.push(payload); },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    relay.push({ payload: 'a' });
    isFailing = false;
    clock.advance(100);
    relay.push({ payload: 'b' });
    clock.advance(200);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(sentList, ['b']);
});
