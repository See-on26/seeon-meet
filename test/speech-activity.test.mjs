import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLastSpeechWallTs } from '../src/renderer/core/trigger/speech-activity.js';

test('마지막 말소리 시각을 벽시계로 바꾼다', () => {
  assert.equal(resolveLastSpeechWallTs({ lastActiveAt: 4000, lastBlindAt: 0, nowPerf: 5000, nowWall: 100000 }), 99000);
});

test('해설 에코로 소리를 못 들은 구간은 말소리가 이어진 것으로 본다', () => {
  assert.equal(resolveLastSpeechWallTs({ lastActiveAt: 1000, lastBlindAt: 4500, nowPerf: 5000, nowWall: 100000 }), 99500);
});

test('말소리도 못 들은 구간도 없으면 0', () => {
  assert.equal(resolveLastSpeechWallTs({ lastActiveAt: 0, lastBlindAt: 0, nowPerf: 5000, nowWall: 100000 }), 0);
});
