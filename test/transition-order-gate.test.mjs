import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TransitionOrderGate, LEADER_STATUS_MAP, resolveFollowerInsertMs,
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
