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
