import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallToVideoTimeMs, resolveSpeechEndWallTs } from '../src/renderer/core/capture/video-time.js';
import { resolveGapSearchFromMs } from '../src/renderer/core/audio-renderer/gap-candidate-store.js';

test('벽시계 시각을 영상 시각으로 환산한다', () => {
  assert.equal(wallToVideoTimeMs({ wallTs: 9000, nowWallTs: 10000, nowVideoTimeMs: 50000 }), 49000);
});

test('환산 결과는 0 아래로 내려가지 않는다', () => {
  assert.equal(wallToVideoTimeMs({ wallTs: 0, nowWallTs: 10000, nowVideoTimeMs: 3000 }), 0);
});

test('입력이 숫자가 아니면 null', () => {
  assert.equal(wallToVideoTimeMs({ wallTs: null, nowWallTs: 10000, nowVideoTimeMs: 3000 }), null);
  assert.equal(wallToVideoTimeMs({ wallTs: 1, nowWallTs: 10000, nowVideoTimeMs: undefined }), null);
});

test('발화 끝은 마지막 세그먼트의 endSec 기준', () => {
  const segmentList = [{ startSec: 0, endSec: 1.2 }, { startSec: 1.4, endSec: 2.1 }];
  assert.equal(resolveSpeechEndWallTs({ chunkStartTs: 1000, chunkEndTs: 3500, segmentList }), 3100);
});

test('세그먼트가 없거나 endSec 가 없으면 청크 끝으로 폴백', () => {
  assert.equal(resolveSpeechEndWallTs({ chunkStartTs: 1000, chunkEndTs: 3500, segmentList: [] }), 3500);
  assert.equal(resolveSpeechEndWallTs({ chunkStartTs: 1000, chunkEndTs: 3500, segmentList: [{ text: 'x' }] }), 3500);
  assert.equal(resolveSpeechEndWallTs({ chunkStartTs: 1000, chunkEndTs: undefined, segmentList: [] }), null);
});

test('틈 탐색 하한은 재생 헤드+안전 마진과 원 사건 중 늦은 쪽', () => {
  assert.equal(resolveGapSearchFromMs({
    eventVideoTimeMs: 20000, delayedTimeMs: 10000, safetyMs: 2000, isBeforeAllowed: false,
  }), 20000);
  assert.equal(resolveGapSearchFromMs({
    eventVideoTimeMs: 5000, delayedTimeMs: 10000, safetyMs: 2000, isBeforeAllowed: false,
  }), 12000);
});

test('화자 식별은 원 사건 3초 전까지 허용', () => {
  assert.equal(resolveGapSearchFromMs({
    eventVideoTimeMs: 20000, delayedTimeMs: 10000, safetyMs: 2000, isBeforeAllowed: true,
  }), 17000);
});

test('원 사건 시각이 없으면 재생 헤드+안전 마진', () => {
  assert.equal(resolveGapSearchFromMs({
    eventVideoTimeMs: null, delayedTimeMs: 10000, safetyMs: 2000, isBeforeAllowed: false,
  }), 12000);
});

test('트리거가 든 세그먼트의 끝을 쓴다', () => {
  const segmentList = [
    { startSec: 0, endSec: 2.0, text: '여기를 보시면' },
    { startSec: 2.5, endSec: 9.5, text: '매출이 꾸준히 늘었습니다' },
  ];
  assert.equal(resolveSpeechEndWallTs({ chunkStartTs: 1000, chunkEndTs: 11000, segmentList, trigger: '여기' }), 3000);
});

test('트리거가 어느 세그먼트에도 없으면 마지막 세그먼트 끝', () => {
  const segmentList = [{ startSec: 0, endSec: 2.0, text: '가' }, { startSec: 2.5, endSec: 9.5, text: '나' }];
  assert.equal(resolveSpeechEndWallTs({ chunkStartTs: 1000, chunkEndTs: 11000, segmentList, trigger: '여기' }), 10500);
});

test('세그먼트 시각은 청크 범위 안으로 자른다', () => {
  const segmentList = [{ startSec: 0, endSec: 30, text: '여기' }];
  assert.equal(resolveSpeechEndWallTs({ chunkStartTs: 1000, chunkEndTs: 3500, segmentList, trigger: '여기' }), 3500);
});
