import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelfMicState, SELF_MIC_STATE_MAP } from '../src/renderer/core/roi/roi-store.js';
import { MeetMicGuard } from '../src/renderer/core/command/meet-mic-guard.js';

test('본인 타일의 마이크 상태를 읽는다', () => {
  assert.equal(resolveSelfMicState([{ isSelf: true, isMuted: false }]), SELF_MIC_STATE_MAP.on);
  assert.equal(resolveSelfMicState([{ isSelf: false, isMuted: false }, { isSelf: true, isMuted: true }]), SELF_MIC_STATE_MAP.muted);
  assert.equal(resolveSelfMicState([{ isSelf: false, isMuted: false }]), SELF_MIC_STATE_MAP.unknown);
  assert.equal(resolveSelfMicState(null), SELF_MIC_STATE_MAP.unknown);
});

function makeGuard(stateList) {
  const toggleList = [];
  const noticeList = [];
  const guard = new MeetMicGuard({
    getSelfMicState: () => stateList.shift() ?? SELF_MIC_STATE_MAP.unknown,
    toggleMeetMic: async () => { toggleList.push('toggle'); return { isOk: true }; },
    wait: async () => {},
    notify: (text) => noticeList.push(text),
  });
  return { guard, toggleList, noticeList };
}

test('켜져 있으면 끄고, 끝나면 다시 켠다', async () => {
  const { guard, toggleList, noticeList } = makeGuard(['on', 'muted', 'on']);
  assert.equal(await guard.muteForRecording(), true);
  await guard.restoreAfterRecording();
  assert.equal(toggleList.length, 2);
  assert.deepEqual(noticeList, []);
});

test('원래 꺼져 있었으면 건드리지 않고 복원도 하지 않는다', async () => {
  const { guard, toggleList } = makeGuard(['muted']);
  assert.equal(await guard.muteForRecording(), false);
  await guard.restoreAfterRecording();
  assert.equal(toggleList.length, 0);
});

test('본인 타일을 못 찾으면 알리기만 한다', async () => {
  const { guard, toggleList, noticeList } = makeGuard(['unknown']);
  assert.equal(await guard.muteForRecording(), false);
  assert.equal(toggleList.length, 0);
  assert.deepEqual(noticeList, ['회의 마이크 상태를 확인하지 못했어요']);
});

test('끄기에 실패하면 알리고 복원하지 않는다', async () => {
  const { guard, toggleList, noticeList } = makeGuard(['on', 'on']);
  assert.equal(await guard.muteForRecording(), false);
  await guard.restoreAfterRecording();
  assert.equal(toggleList.length, 1);
  assert.deepEqual(noticeList, ['회의 마이크를 끄지 못했어요']);
});

test('복원 뒤에도 꺼져 있으면 알린다', async () => {
  const { guard, noticeList } = makeGuard(['on', 'muted', 'muted']);
  await guard.muteForRecording();
  await guard.restoreAfterRecording();
  assert.deepEqual(noticeList, ['회의 마이크를 다시 켜지 못했어요']);
});
