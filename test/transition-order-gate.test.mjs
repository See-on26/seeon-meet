import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TransitionOrderGate, LEADER_STATUS_MAP, resolveFollowerInsertMs,
  PendingTransitionTracker, resolveAfterTransitionInsertMs,
} from '../src/renderer/core/audio-renderer/transition-order-gate.js';

test('전환 고지가 없던 슬라이드의 후속 묘사는 자기 원 사건 시각에 재생한다', async () => {
  const gate = new TransitionOrderGate();
  const leader = await gate.waitLeader({ slideLabel: '3' });
  assert.equal(leader.status, LEADER_STATUS_MAP.none);
  assert.equal(resolveFollowerInsertMs({ eventVideoTimeMs: 5000, leader }), 5000);
});

test('후속 묘사는 전환 고지가 삽입 시각을 정할 때까지 기다렸다가 그 바로 뒤에 붙는다', async () => {
  const gate = new TransitionOrderGate();
  const handle = gate.registerLeader({ slideLabel: '3' });
  let isResolved = false;
  const waiting = gate.waitLeader({ slideLabel: '3' }).then((leader) => { isResolved = true; return leader; });
  await Promise.resolve();
  assert.equal(isResolved, false);
  handle.settle({ status: LEADER_STATUS_MAP.scheduled, insertVideoTimeMs: 7200 });
  const leader = await waiting;
  assert.equal(resolveFollowerInsertMs({ eventVideoTimeMs: 5000, leader }), 7201);
});

test('전환 고지가 체류 미달로 취소되면 후속 묘사도 버린다', async () => {
  const gate = new TransitionOrderGate();
  gate.registerLeader({ slideLabel: '4' }).settle({ status: LEADER_STATUS_MAP.cancelled });
  const leader = await gate.waitLeader({ slideLabel: '4' });
  assert.equal(resolveFollowerInsertMs({ eventVideoTimeMs: 5000, leader }), null);
});

test('전환 고지가 소리 없이 끝났으면 후속 묘사는 자기 시각에 재생한다', async () => {
  const gate = new TransitionOrderGate();
  gate.registerLeader({ slideLabel: '5' }).settle({ status: LEADER_STATUS_MAP.unscheduled });
  const leader = await gate.waitLeader({ slideLabel: '5' });
  assert.equal(resolveFollowerInsertMs({ eventVideoTimeMs: 5000, leader }), 5000);
});

test('두 번 settle 해도 첫 결과가 유지된다', async () => {
  const gate = new TransitionOrderGate();
  const handle = gate.registerLeader({ slideLabel: '6' });
  handle.settle({ status: LEADER_STATUS_MAP.scheduled, insertVideoTimeMs: 100 });
  handle.settle({ status: LEADER_STATUS_MAP.unscheduled });
  const leader = await gate.waitLeader({ slideLabel: '6' });
  assert.equal(leader.status, LEADER_STATUS_MAP.scheduled);
});

test('reset 하면 등록이 사라진다', async () => {
  const gate = new TransitionOrderGate();
  gate.registerLeader({ slideLabel: '7' });
  gate.reset();
  const leader = await gate.waitLeader({ slideLabel: '7' });
  assert.equal(leader.status, LEADER_STATUS_MAP.none);
});

function createManualTimer() {
  const timerList = [];
  return {
    timerList,
    setTimer: (fn, ms) => { timerList.push({ fn, ms, isCleared: false }); return timerList.length - 1; },
    clearTimer: (handle) => { if (timerList[handle]) timerList[handle].isCleared = true; },
  };
}

test('진행 중인 전환이 없으면 화자 안내는 기다리지 않고 자기 시각에 들어간다', async () => {
  const tracker = new PendingTransitionTracker(createManualTimer());
  assert.equal(tracker.hasPending, false);
  const leaderList = await tracker.waitAll();
  assert.deepEqual(leaderList, []);
  assert.equal(resolveAfterTransitionInsertMs({ insertVideoTimeMs: 4000, leaderList }), 4000);
});

test('전환을 확정한 뒤 도착한 화자 안내는 그 고지가 정해질 때까지 기다렸다가 고지 바로 뒤에 들어간다', async () => {
  const tracker = new PendingTransitionTracker(createManualTimer());
  tracker.open({ slideLabel: '5' });
  let isResolved = false;
  const waiting = tracker.waitAll().then((leaderList) => { isResolved = true; return leaderList; });
  await Promise.resolve();
  assert.equal(isResolved, false);
  tracker.settle({ slideLabel: '5', status: LEADER_STATUS_MAP.scheduled, insertVideoTimeMs: 9000 });
  const leaderList = await waiting;
  assert.equal(resolveAfterTransitionInsertMs({ insertVideoTimeMs: 6000, leaderList }), 9001);
  assert.equal(tracker.hasPending, false);
});

test('전환 고지가 취소·미정이면 화자 안내는 자기 시각을 쓴다(버리지 않는다)', async () => {
  const tracker = new PendingTransitionTracker(createManualTimer());
  tracker.open({ slideLabel: '6' });
  tracker.open({ slideLabel: '7' });
  const waiting = tracker.waitAll();
  tracker.settle({ slideLabel: '6', status: LEADER_STATUS_MAP.cancelled });
  tracker.settle({ slideLabel: '7', status: LEADER_STATUS_MAP.unscheduled });
  const leaderList = await waiting;
  assert.equal(resolveAfterTransitionInsertMs({ insertVideoTimeMs: 6000, leaderList }), 6000);
});

test('고지가 끝내 정해지지 않으면 상한 시간 뒤에 화자 안내를 풀어 준다', async () => {
  const timer = createManualTimer();
  const tracker = new PendingTransitionTracker({ ...timer, maxWaitMs: 10000 });
  tracker.open({ slideLabel: '8' });
  const waiting = tracker.waitAll();
  assert.equal(timer.timerList[0].ms, 10000);
  timer.timerList[0].fn();
  const [leader] = await waiting;
  assert.equal(leader.status, LEADER_STATUS_MAP.unscheduled);
});

test('세션을 초기화하면 기다리던 화자 안내를 모두 풀어 준다', async () => {
  const tracker = new PendingTransitionTracker(createManualTimer());
  tracker.open({ slideLabel: '9' });
  const waiting = tracker.waitAll();
  tracker.reset();
  const [leader] = await waiting;
  assert.equal(leader.status, LEADER_STATUS_MAP.unscheduled);
  assert.equal(tracker.hasPending, false);
});
