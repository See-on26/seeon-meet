import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWithinLongEdge, MAX_FRAME_LONG_EDGE_PX } from '../src/renderer/core/capture/frame-scale.js';

test('긴 변이 상한을 넘으면 비율을 지켜 상한에 맞춘다', () => {
  const longEdge = MAX_FRAME_LONG_EDGE_PX;
  const { width, height } = fitWithinLongEdge({ width: longEdge * 2, height: longEdge });
  assert.equal(width, longEdge);
  assert.equal(height, Math.round(longEdge / 2));
});

test('세로가 긴 영역은 세로를 상한에 맞춘다', () => {
  const { width, height } = fitWithinLongEdge({ width: 900, height: 1800, maxLongEdge: 1200 });
  assert.deepEqual({ width, height }, { width: 600, height: 1200 });
});

test('상한보다 작은 영역은 키우지 않는다', () => {
  assert.deepEqual(fitWithinLongEdge({ width: 640.4, height: 359.6, maxLongEdge: 1280 }), { width: 640, height: 360 });
});

test('아주 작은 영역도 2px 보다 작아지지 않는다', () => {
  assert.deepEqual(fitWithinLongEdge({ width: 4000, height: 1, maxLongEdge: 1000 }), { width: 1000, height: 2 });
});
