import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldCutSegment, DEFAULT_MAX_EXTEND_MS, DEFAULT_EXTEND_SILENCE_CUT_MS,
} from '../src/renderer/core/trigger/asr-segmenter.js';

// 조각 길이(균형 3초)에서 말하는 도중에 강제로 자르면 Whisper 가 잘린 음절을 버린다
// (실험실 D: "…해마다 크게 늘" | "다른 지역도 차례로 주" — "었습니다"가 사라져 변화 해설이 빠짐).
// 길이가 찼을 때 말하는 중이면 낱말 사이 짧은 쉼까지 기다리되, 최대 1.5초까지만 늘린다.
const base = {
  segmentMs: 3000, minSegmentMs: 2500, silenceCutMs: 400, minVoicedMs: 200, hasVad: true,
};

test('길이가 차기 전에는 말하는 중이면 자르지 않고, 최소 길이 넘어 0.4초 쉬면 자른다', () => {
  assert.equal(shouldCutSegment({ ...base, elapsedMs: 2000, silenceMs: 0, voicedMs: 1800 }), false);
  assert.equal(shouldCutSegment({ ...base, elapsedMs: 2600, silenceMs: 400, voicedMs: 2000 }), true);
  assert.equal(shouldCutSegment({ ...base, elapsedMs: 2600, silenceMs: 200, voicedMs: 2000 }), false);
});

test('길이가 찼을 때 말하는 중이면 자르지 않고 기다린다', () => {
  assert.equal(shouldCutSegment({ ...base, elapsedMs: 3000, silenceMs: 0, voicedMs: 2800 }), false);
  assert.equal(shouldCutSegment({ ...base, elapsedMs: 3600, silenceMs: 100, voicedMs: 3300 }), false);
});

test('길이를 넘긴 뒤에는 낱말 사이 짧은 쉼(0.2초)에서 바로 자른다', () => {
  assert.equal(DEFAULT_EXTEND_SILENCE_CUT_MS, 200);
  assert.equal(shouldCutSegment({ ...base, elapsedMs: 3400, silenceMs: 200, voicedMs: 3100 }), true);
});

test('말이 계속 이어져도 길이 + 1.5초가 되면 자른다', () => {
  assert.equal(DEFAULT_MAX_EXTEND_MS, 1500);
  assert.equal(shouldCutSegment({ ...base, elapsedMs: 4499, silenceMs: 0, voicedMs: 4400 }), false);
  assert.equal(shouldCutSegment({ ...base, elapsedMs: 4500, silenceMs: 0, voicedMs: 4400 }), true);
});

test('말소리가 거의 없던 조각은 늘리지 않고 길이가 차면 자른다', () => {
  assert.equal(shouldCutSegment({ ...base, elapsedMs: 3000, silenceMs: 3000, voicedMs: 0 }), true);
});

test('말소리 측정(VAD)이 없으면 예전처럼 길이가 차면 자른다', () => {
  assert.equal(shouldCutSegment({ ...base, hasVad: false, elapsedMs: 2999, silenceMs: 0, voicedMs: 0 }), false);
  assert.equal(shouldCutSegment({ ...base, hasVad: false, elapsedMs: 3000, silenceMs: 0, voicedMs: 0 }), true);
});
