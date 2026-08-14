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

function installAudioFakes({ recorderThrows = false } = {}) {
  const trackList = [{ stopped: false, stop() { this.stopped = true; } }];
  globalThis.AudioContext = class {
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (buffer) => buffer.fill(0) }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { return Promise.resolve(); }
  };
  globalThis.MediaRecorder = class {
    constructor() { if (recorderThrows) throw new Error('codec'); this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
  };
  return { stream: { getTracks: () => trackList }, trackList };
}

test('녹음기 준비 중 예외가 나면 마이크를 닫고 취소를 알린다', async () => {
  const { QuestionRecorder } = await import('../src/renderer/core/command/question-recorder.js');
  const { stream, trackList } = installAudioFakes({ recorderThrows: true });
  const cancelList = [];
  const recorder = new QuestionRecorder({ getUserMedia: async () => stream, onFinish: () => {}, onCancel: (event) => cancelList.push(event.reason) });
  assert.equal(await recorder.start(), false);
  assert.equal(recorder.isRecording, false);
  assert.equal(trackList[0].stopped, true);
  assert.deepEqual(cancelList, ['error']);
});

test('cancel 은 녹음을 멈추고 전사하지 않고 취소를 알린다', async () => {
  const { QuestionRecorder } = await import('../src/renderer/core/command/question-recorder.js');
  const { stream } = installAudioFakes();
  const cancelList = [];
  const finishList = [];
  const recorder = new QuestionRecorder({ getUserMedia: async () => stream, onFinish: (event) => finishList.push(event), onCancel: (event) => cancelList.push(event.reason) });
  assert.equal(await recorder.start(), true);
  recorder.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(cancelList, ['cancelled']);
  assert.equal(finishList.length, 0);
  assert.equal(recorder.isRecording, false);
});
