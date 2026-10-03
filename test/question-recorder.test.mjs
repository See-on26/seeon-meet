import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecorderStop, RECORDER_STOP_REASON_MAP } from '../src/renderer/core/command/question-recorder.js';

test('말을 한 뒤 1.5초 무음이면 끝낸다', () => {
  assert.equal(resolveRecorderStop({ elapsedMs: 3000, voicedMs: 800, silenceMs: 1500, isToggled: false }), RECORDER_STOP_REASON_MAP.silence);
  assert.equal(resolveRecorderStop({ elapsedMs: 3000, voicedMs: 800, silenceMs: 1400, isToggled: false }), null);
});

test('말하기 전 무음으로는 끝내지 않는다', () => {
  assert.equal(resolveRecorderStop({ elapsedMs: 5000, voicedMs: 100, silenceMs: 5000, isToggled: false }), null);
});

test('15초가 되면 끝내고, 그때까지 말이 없었으면 no_voice', () => {
  assert.equal(resolveRecorderStop({ elapsedMs: 15000, voicedMs: 500, silenceMs: 0, isToggled: false }), RECORDER_STOP_REASON_MAP.maxLength);
  assert.equal(resolveRecorderStop({ elapsedMs: 15000, voicedMs: 100, silenceMs: 15000, isToggled: false }), RECORDER_STOP_REASON_MAP.noVoice);
});

test('다시 누르면 끝내고, 말이 없었으면 no_voice', () => {
  assert.equal(resolveRecorderStop({ elapsedMs: 1000, voicedMs: 300, silenceMs: 0, isToggled: true }), RECORDER_STOP_REASON_MAP.manual);
  assert.equal(resolveRecorderStop({ elapsedMs: 1000, voicedMs: 0, silenceMs: 1000, isToggled: true }), RECORDER_STOP_REASON_MAP.noVoice);
});
