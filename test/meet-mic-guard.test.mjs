import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelfMicState, SELF_MIC_STATE_MAP } from '../src/renderer/core/roi/roi-store.js';
import { MeetMicGuard } from '../src/renderer/core/command/meet-mic-guard.js';

// roi-scanner 가 실제로 보내는 형태: 본인 타일은 isSelf, 음소거는 micMuted.
test('본인 타일의 마이크 상태를 roi-scanner 형태(micMuted)로 읽는다', () => {
  assert.equal(resolveSelfMicState([{ isSelf: true, micMuted: false }]), SELF_MIC_STATE_MAP.on);
  assert.equal(resolveSelfMicState([{ isSelf: false, micMuted: false }, { isSelf: true, micMuted: true }]), SELF_MIC_STATE_MAP.muted);
  assert.equal(resolveSelfMicState([{ isSelf: false, micMuted: false }]), SELF_MIC_STATE_MAP.unknown);
  assert.equal(resolveSelfMicState(null), SELF_MIC_STATE_MAP.unknown);
});

test('음소거 값이 boolean 이 아니면 상태를 모르는 것으로 본다', () => {
  assert.equal(resolveSelfMicState([{ isSelf: true }]), SELF_MIC_STATE_MAP.unknown);
  assert.equal(resolveSelfMicState([{ isSelf: true, micMuted: 'yes' }]), SELF_MIC_STATE_MAP.unknown);
});

function makeGuard(stateList) {
  const toggleList = [];
  const noticeList = [];
  const guard = new MeetMicGuard({
    getSelfMicState: () => (stateList.length ? stateList.shift() : SELF_MIC_STATE_MAP.unknown),
    toggleMeetMic: async () => { toggleList.push('toggle'); return { isOk: true }; },
    wait: async () => {},
    notify: (text) => noticeList.push(text),
  });
  return { guard, toggleList, noticeList };
}

test('원래 꺼져 있던 마이크(micMuted=true)는 토글하지 않고 복원도 하지 않는다', async () => {
  const { guard, toggleList, noticeList } = makeGuard(['muted', 'muted']);
  assert.equal(await guard.muteForRecording(), false);
  await guard.restoreAfterRecording();
  assert.equal(toggleList.length, 0);
  assert.deepEqual(noticeList, []);
});

test('켜져 있으면 끄고, 상태 갱신이 늦어도 꺼질 때까지 기다린 뒤 끝나면 다시 켠다', async () => {
  const { guard, toggleList, noticeList } = makeGuard(['on', 'on', 'muted', 'muted', 'on']);
  assert.equal(await guard.muteForRecording(), true);
  await guard.restoreAfterRecording();
  assert.equal(toggleList.length, 2);
  assert.deepEqual(noticeList, []);
});

test('본인 타일을 못 찾으면 알리기만 한다', async () => {
  const { guard, toggleList, noticeList } = makeGuard(['unknown']);
  assert.equal(await guard.muteForRecording(), false);
  await guard.restoreAfterRecording();
  assert.equal(toggleList.length, 0);
  assert.deepEqual(noticeList, ['회의 마이크 상태를 확인하지 못했어요']);
});

test('끝까지 꺼지지 않으면 알리고, 끝날 때도 켜져 있으면 복원하지 않는다', async () => {
  const { guard, toggleList, noticeList } = makeGuard([...Array(7).fill('on'), 'on']);
  assert.equal(await guard.muteForRecording(), false);
  await guard.restoreAfterRecording();
  assert.equal(toggleList.length, 1);
  assert.deepEqual(noticeList, ['회의 마이크를 끄지 못했어요']);
});

test('확인 시간 안에 못 봤어도 끝날 때 꺼져 있으면 우리가 끈 것이므로 되돌린다', async () => {
  const { guard, toggleList, noticeList } = makeGuard([...Array(7).fill('on'), 'muted', 'on']);
  await guard.muteForRecording();
  await guard.restoreAfterRecording();
  assert.equal(toggleList.length, 2);
  assert.deepEqual(noticeList, ['회의 마이크를 끄지 못했어요']);
});

test('복원 뒤에도 꺼져 있으면 알린다', async () => {
  const { guard, noticeList } = makeGuard(['on', 'muted', 'muted', ...Array(6).fill('muted')]);
  await guard.muteForRecording();
  await guard.restoreAfterRecording();
  assert.deepEqual(noticeList, ['회의 마이크를 다시 켜지 못했어요']);
});
