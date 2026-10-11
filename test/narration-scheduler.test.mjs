import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NarrationScheduler } from '../src/renderer/core/audio-renderer/narration-scheduler.js';

test('삽입 일정을 비우면 기다리던 해설을 돌려준다(재생 못 한 것으로 알리기 위해)', () => {
  const dueList = [];
  const scheduler = new NarrationScheduler({
    getPlaybackTimeMs: () => 0, onDue: (item) => dueList.push(item),
    setTimer: () => 1, clearTimer: () => {},
  });
  scheduler.schedule({ entry: { text: 'a' }, captionCaptureMs: 5000 });
  scheduler.schedule({ entry: { text: 'b' }, captionCaptureMs: 9000 });
  assert.deepEqual(scheduler.reset().map((item) => item.entry.text), ['a', 'b']);
  assert.equal(scheduler.pendingCount, 0);
  assert.deepEqual(dueList, []);
});

test('삽입 시각은 50ms 마다 확인한다(틈 뒤 무음 0.2초 요구가 이 주기에 기댄다)', () => {
  let pollMs = null;
  const scheduler = new NarrationScheduler({
    getPlaybackTimeMs: () => 0, onDue: () => {},
    setTimer: (_fn, ms) => { pollMs = ms; return 1; }, clearTimer: () => {},
  });
  scheduler.start();
  assert.equal(pollMs, 50);
});
