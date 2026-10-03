import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODE_MAP, getModePolicy } from '../src/renderer/core/mode/mode-policy.js';
import { AsrSegmenter, isSegmentCutReady } from '../src/renderer/core/trigger/asr-segmenter.js';

const REALTIME_MODE_LIST = [MODE_MAP.realtimeMix, MODE_MAP.realtimeSic];
const CROSS_MODE_LIST = [MODE_MAP.delayed, MODE_MAP.listening];

test('동시·성능 모드는 무음 절단 최소 길이가 최대 길이보다 짧아 무음에서 자를 수 있다', () => {
  for (const mode of REALTIME_MODE_LIST) {
    const policy = getModePolicy({ mode });
    assert.equal(policy.asrMinSegmentMs, 1500, mode);
    assert.ok(policy.asrMinSegmentMs < policy.asrSegmentMs, mode);
  }
});

test('균형·품질 모드는 무음 절단 최소 길이를 그대로 둔다', () => {
  for (const mode of CROSS_MODE_LIST) {
    assert.equal(getModePolicy({ mode }).asrMinSegmentMs, 2500, mode);
  }
});

test('동시 모드 값이면 1.5초 넘어 0.4초 무음에서 자를 준비가 된다', () => {
  const { asrMinSegmentMs } = getModePolicy({ mode: MODE_MAP.realtimeMix });
  assert.equal(isSegmentCutReady({
    elapsedMs: 1600, silenceMs: 400, minSegmentMs: asrMinSegmentMs, silenceCutMs: 400,
  }), true);
});

test('setSegmentMs 는 최소 길이도 함께 바꾼다', () => {
  const segmenter = new AsrSegmenter({ onSegment: () => {} });
  segmenter.setSegmentMs({ segmentMs: 2500, minSegmentMs: 1500 });
  assert.equal(segmenter.segmentMs, 2500);
  assert.equal(segmenter.minSegmentMs, 1500);
});

test('최소 길이는 최대 길이를 넘지 않게 자른다', () => {
  const segmenter = new AsrSegmenter({ onSegment: () => {} });
  segmenter.setSegmentMs({ segmentMs: 2000, minSegmentMs: 2500 });
  assert.equal(segmenter.minSegmentMs, 2000);
});

test('최소 길이를 안 주거나 잘못 주면 기존 값을 유지한다', () => {
  const segmenter = new AsrSegmenter({ onSegment: () => {}, minSegmentMs: 2500 });
  segmenter.setSegmentMs({ segmentMs: 3000 });
  assert.equal(segmenter.minSegmentMs, 2500);
  segmenter.setSegmentMs({ segmentMs: 3000, minSegmentMs: -1 });
  assert.equal(segmenter.minSegmentMs, 2500);
});
