import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as rendererConstants from '../src/renderer/core/constants.js';

const require = createRequire(import.meta.url);
const mainNarrationTypes = require('../src/main/caption-pipeline/contracts/narration-types.js');
const mainDebugEvents = require('../src/main/caption-pipeline/contracts/debug-events.js');

test('재생 분류 enum 은 main 과 렌더러가 같다', () => {
  assert.deepEqual(rendererConstants.NARRATION_CLASS_MAP, mainNarrationTypes.NARRATION_CLASS_MAP);
});

test('재생 분류는 6종이다', () => {
  assert.deepEqual(
    Object.values(mainNarrationTypes.NARRATION_CLASS_MAP).sort(),
    ['deixis', 'page_transition', 'silence_based', 'speaker_identity', 'speech_based', 'user_command'],
  );
});

test('내레이션 유형 enum 은 main 과 렌더러가 같다', () => {
  assert.deepEqual(rendererConstants.NARRATION_TYPE_MAP, mainNarrationTypes.NARRATION_TYPE_MAP);
});

test('디버그 단계 enum 은 main 과 렌더러가 같다', () => {
  assert.deepEqual(rendererConstants.DEBUG_STAGE_MAP, mainDebugEvents.DEBUG_STAGE_MAP);
});

test('값 검사·VLM 폴백 디버그 단계가 있다', () => {
  assert.equal(mainDebugEvents.DEBUG_STAGE_MAP.valueCheck, 'value_check');
  assert.equal(mainDebugEvents.DEBUG_STAGE_MAP.vlmFallback, 'vlm_fallback');
});
