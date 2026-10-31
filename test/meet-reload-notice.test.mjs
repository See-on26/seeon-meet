import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeetReloadNotice } from '../src/renderer/core/ui/meet-reload-notice.js';
import { MEET_RELOAD_TARGET_MAP } from '../src/renderer/core/constants.js';

test('회의를 다시 불렀으면 다시 참여하라고 안내한다', () => {
  assert.equal(buildMeetReloadNotice({ target: MEET_RELOAD_TARGET_MAP.meeting, isCaptureActive: false }),
    'Meet 화면을 새로고침했어요. 회의에 다시 참여해 주세요');
  assert.equal(buildMeetReloadNotice({ target: MEET_RELOAD_TARGET_MAP.meeting, isCaptureActive: true }),
    'Meet 화면을 새로고침했어요. 회의에 다시 참여한 뒤, 캡처가 멈췄다면 다시 시작해 주세요');
});

test('회의 밖에서 첫 화면으로 돌아갔으면 회의 코드를 넣어 참여하라고 안내한다', () => {
  assert.equal(buildMeetReloadNotice({ target: MEET_RELOAD_TARGET_MAP.home, isCaptureActive: false }),
    'Meet 첫 화면으로 돌아왔어요. 회의 코드를 넣거나 회의 링크로 참여해 주세요');
  assert.equal(buildMeetReloadNotice({ target: MEET_RELOAD_TARGET_MAP.home, isCaptureActive: true }),
    'Meet 첫 화면으로 돌아왔어요. 회의에 다시 참여한 뒤, 캡처가 멈췄다면 다시 시작해 주세요');
});

test('예전 알림처럼 target 이 없으면 회의 새로고침으로 본다', () => {
  assert.equal(buildMeetReloadNotice({ target: undefined, isCaptureActive: false }),
    'Meet 화면을 새로고침했어요. 회의에 다시 참여해 주세요');
});
