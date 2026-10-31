import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPointingMotionTracker, MOTION_WINDOW_MS, MIN_MOVING_PLACE_COUNT, MAX_POINTING_CHANGED_RATIO,
} from '../src/renderer/core/trigger/pointing-motion-tracker.js';

// 실험실 7회 실측(10/17): 펜 점은 대상 주위를 돌아 0.4초마다 영역 위치가 바뀌고(펜 63/77 이 최근 2초 3곳 이상),
// 캡처·압축 잡음은 같은 자리에서 같은 세기로 반복되거나 두 자리를 오갈 뿐이며, 슬라이드 전환은 화면 34~46% 가 한꺼번에 바뀐다.
const cellRect = (col, row) => ({ x: col / 32, y: row / 18, w: 1 / 32, h: 1 / 18 });

function feed(tracker, sampleList, stepMs = 400) {
  return sampleList.map((sample, index) => {
    const ts = 10_000 + index * stepMs;
    tracker.add({ ts, rect: sample.rect, changedRatio: sample.changedRatio ?? 0.003 });
    return tracker.isMoving({ nowTs: ts });
  });
}

test('기준값: 최근 2초, 3곳 이상, 화면 10% 이하 변화', () => {
  assert.equal(MOTION_WINDOW_MS, 2000);
  assert.equal(MIN_MOVING_PLACE_COUNT, 3);
  assert.equal(MAX_POINTING_CHANGED_RATIO, 0.1);
});

test('펜 점이 대상 주위를 돌면 세 번째 자리부터 움직이는 가리킴으로 본다', () => {
  const tracker = createPointingMotionTracker();
  const result = feed(tracker, [cellRect(6, 6), cellRect(2, 6), cellRect(2, 5), cellRect(5, 6)].map((rect) => ({ rect })));
  assert.deepEqual(result, [false, false, true, true]);
});

test('같은 자리에서 반복되는 깜빡임은 움직임이 아니다', () => {
  const tracker = createPointingMotionTracker();
  const result = feed(tracker, Array.from({ length: 8 }, () => ({ rect: { x: 0.625, y: 0.722, w: 0.063, h: 0.056 } })));
  assert.ok(result.every((isMoving) => !isMoving));
});

test('두 자리를 번갈아 오가는 잡음도 움직임이 아니다', () => {
  const tracker = createPointingMotionTracker();
  const result = feed(tracker, Array.from({ length: 8 }, (_, i) => ({ rect: i % 2 ? cellRect(26, 14) : cellRect(20, 17) })));
  assert.ok(result.every((isMoving) => !isMoving));
});

test('화면이 한꺼번에 크게 바뀐 표본(슬라이드 전환)은 자리로 세지 않는다', () => {
  const tracker = createPointingMotionTracker();
  const result = feed(tracker, [
    { rect: { x: 0.031, y: 0.056, w: 0.906, h: 0.833 }, changedRatio: 0.344 },
    { rect: cellRect(20, 13), changedRatio: 0.003 },
    { rect: { x: 0, y: 0.056, w: 0.969, h: 0.944 }, changedRatio: 0.464 },
    { rect: cellRect(21, 13), changedRatio: 0.003 },
  ]);
  assert.ok(result.every((isMoving) => !isMoving));
});

test('2초가 지난 자리는 세지 않는다', () => {
  const tracker = createPointingMotionTracker();
  feed(tracker, [cellRect(1, 1), cellRect(5, 1)].map((rect) => ({ rect })), 400);
  tracker.add({ ts: 10_400 + MOTION_WINDOW_MS + 1, rect: cellRect(9, 1), changedRatio: 0.003 });
  assert.equal(tracker.isMoving({ nowTs: 10_400 + MOTION_WINDOW_MS + 1 }), false);
});

test('지우면 앞 표본을 잊는다', () => {
  const tracker = createPointingMotionTracker();
  feed(tracker, [cellRect(1, 1), cellRect(5, 1)].map((rect) => ({ rect })));
  tracker.reset();
  tracker.add({ ts: 10_800, rect: cellRect(9, 1), changedRatio: 0.003 });
  assert.equal(tracker.isMoving({ nowTs: 10_800 }), false);
});
