import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SilenceSpanTracker, classifyLevelTick, LEVEL_TICK_KIND_MAP,
} from '../src/renderer/core/audio-renderer/silence-span-tracker.js';

const SPEECH = 0.05;
const QUIET = 0.005;
const BETWEEN = 0.015;

function feed(tracker, levelList, { fromMs = 0, stepMs = 100 } = {}) {
  levelList.forEach((level, index) => tracker.update({ videoTimeMs: fromMs + index * stepMs, level }));
}

test('레벨 틱은 말소리·무음·사이·측정 없음으로 나뉜다', () => {
  assert.equal(classifyLevelTick({ level: 0.03 }), LEVEL_TICK_KIND_MAP.speech);
  assert.equal(classifyLevelTick({ level: 0.005 }), LEVEL_TICK_KIND_MAP.silence);
  assert.equal(classifyLevelTick({ level: 0.015 }), LEVEL_TICK_KIND_MAP.between);
  assert.equal(classifyLevelTick({ level: null }), LEVEL_TICK_KIND_MAP.unknown);
  assert.equal(classifyLevelTick({ level: Number.NaN }), LEVEL_TICK_KIND_MAP.unknown);
});

test('무음 2틱은 구간이 아니고 3틱이면 첫 무음 틱 시각에서 시작한다', () => {
  const twoTick = new SilenceSpanTracker();
  feed(twoTick, [SPEECH, QUIET, QUIET, SPEECH]);
  assert.deepEqual(twoTick.getSpanList(), []);

  const threeTick = new SilenceSpanTracker();
  feed(threeTick, [SPEECH, QUIET, QUIET, QUIET]);
  assert.deepEqual(threeTick.getSpanList(), [{ startMs: 100, endMs: 300, isOpen: true }]);
});

test('말소리 1틱이 구간을 닫고, 끝은 마지막 무음 틱 시각이다', () => {
  const tracker = new SilenceSpanTracker();
  feed(tracker, [SPEECH, QUIET, QUIET, QUIET, QUIET, QUIET, SPEECH, SPEECH]);
  assert.deepEqual(tracker.getSpanList(), [{ startMs: 100, endMs: 500, isOpen: false }]);
});

test('무음과 말소리 사이 값은 앞 상태를 이어 간다', () => {
  const inSilence = new SilenceSpanTracker();
  feed(inSilence, [SPEECH, QUIET, QUIET, QUIET, BETWEEN, BETWEEN, QUIET, SPEECH]);
  assert.deepEqual(inSilence.getSpanList(), [{ startMs: 100, endMs: 600, isOpen: false }]);

  const inSpeech = new SilenceSpanTracker();
  feed(inSpeech, [SPEECH, BETWEEN, BETWEEN, BETWEEN, BETWEEN, SPEECH]);
  assert.deepEqual(inSpeech.getSpanList(), []);

  const breaksPending = new SilenceSpanTracker();
  feed(breaksPending, [SPEECH, QUIET, QUIET, BETWEEN, QUIET, QUIET, SPEECH]);
  assert.deepEqual(breaksPending.getSpanList(), []);
});

test('틱 간격이 300ms 를 넘으면 무음 구간이 그 너머로 이어지지 않는다', () => {
  const tracker = new SilenceSpanTracker();
  feed(tracker, [SPEECH, QUIET, QUIET, QUIET, QUIET]);
  feed(tracker, [QUIET, QUIET, QUIET, SPEECH], { fromMs: 1000 });
  assert.deepEqual(tracker.getSpanList(), [
    { startMs: 100, endMs: 400, isOpen: false },
    { startMs: 1000, endMs: 1200, isOpen: false },
  ]);
});

test('측정이 없는 틱(level=null)은 구간을 끊고 측정 범위에서 빠진다', () => {
  const tracker = new SilenceSpanTracker();
  feed(tracker, [SPEECH, QUIET, QUIET, QUIET, null, null, QUIET, QUIET, QUIET, SPEECH]);
  assert.deepEqual(tracker.getSpanList(), [
    { startMs: 100, endMs: 300, isOpen: false },
    { startMs: 600, endMs: 800, isOpen: false },
  ]);
  assert.deepEqual(tracker.getCoverageList(), [{ fromMs: 0, toMs: 300 }, { fromMs: 600, toMs: 900 }]);
  assert.equal(tracker.isMeasuredAt(450), false);
  assert.equal(tracker.isMeasuredAt(700), true);
});

test('isBlind 로 받은 틱은 판단하지 않는다(기본은 판단한다)', () => {
  const tracker = new SilenceSpanTracker();
  tracker.update({ videoTimeMs: 0, level: SPEECH });
  for (let ms = 100; ms <= 500; ms += 100) tracker.update({ videoTimeMs: ms, level: QUIET, isBlind: true });
  tracker.update({ videoTimeMs: 600, level: SPEECH });
  assert.deepEqual(tracker.getSpanList(), []);
});

test('보관 시간이 지난 구간과 닫힌 측정 범위는 버린다', () => {
  const tracker = new SilenceSpanTracker({ retainMs: 1000 });
  feed(tracker, [SPEECH, QUIET, QUIET, QUIET, SPEECH, null]);
  feed(tracker, Array.from({ length: 20 }, () => SPEECH), { fromMs: 600 });
  assert.deepEqual(tracker.getSpanList(), []);
  assert.deepEqual(tracker.getCoverageList(), [{ fromMs: 600, toMs: 2500 }]);
});

test('구간 끝의 사이 값 틱은 무음으로 치지 않는다(끝은 마지막 무음 틱)', () => {
  const closed = new SilenceSpanTracker();
  feed(closed, [SPEECH, QUIET, QUIET, QUIET, BETWEEN, BETWEEN, SPEECH]);
  assert.deepEqual(closed.getSpanList(), [{ startMs: 100, endMs: 300, isOpen: false }]);

  const open = new SilenceSpanTracker();
  feed(open, [SPEECH, QUIET, QUIET, QUIET, BETWEEN]);
  assert.deepEqual(open.getSpanList(), [{ startMs: 100, endMs: 300, isOpen: true }]);
});

test('틱 간격이 정확히 300ms 면 이어지고 301ms 면 끊긴다', () => {
  const joined = new SilenceSpanTracker();
  feed(joined, [SPEECH, QUIET, QUIET, QUIET]);
  joined.update({ videoTimeMs: 600, level: QUIET });
  joined.update({ videoTimeMs: 700, level: SPEECH });
  assert.deepEqual(joined.getSpanList(), [{ startMs: 100, endMs: 600, isOpen: false }]);

  const broken = new SilenceSpanTracker();
  feed(broken, [SPEECH, QUIET, QUIET, QUIET]);
  broken.update({ videoTimeMs: 601, level: QUIET });
  broken.update({ videoTimeMs: 701, level: SPEECH });
  assert.deepEqual(broken.getSpanList(), [{ startMs: 100, endMs: 300, isOpen: false }]);
});

test('reset 하면 구간·측정 범위·진행 중 판단이 모두 비워진다', () => {
  const tracker = new SilenceSpanTracker();
  feed(tracker, [SPEECH, QUIET, QUIET, QUIET, QUIET]);
  tracker.reset();
  assert.deepEqual(tracker.getSpanList(), []);
  assert.deepEqual(tracker.getCoverageList(), []);
  feed(tracker, [QUIET, QUIET], { fromMs: 5000 });
  assert.deepEqual(tracker.getSpanList(), []);
});
