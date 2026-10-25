import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as rendererConstants from '../src/renderer/core/constants.js';

const require = createRequire(import.meta.url);
const mainNarrationTypes = require('../src/main/caption-pipeline/contracts/narration-types.js');
const mainDebugEvents = require('../src/main/caption-pipeline/contracts/debug-events.js');
const mainNarrationClass = require('../src/main/caption-pipeline/contracts/narration-class.js');
const mainSummaryGenerator = require('../src/main/summary/summary-generator.js');

test('재생 분류 enum 은 main 과 렌더러가 같다', () => {
  assert.deepEqual(rendererConstants.NARRATION_CLASS_MAP, mainNarrationTypes.NARRATION_CLASS_MAP);
});

test('재생 분류는 7종이다', () => {
  assert.deepEqual(
    Object.values(mainNarrationTypes.NARRATION_CLASS_MAP).sort(),
    ['deixis', 'page_transition', 'screen_change', 'silence_based', 'speaker_identity', 'speech_based', 'user_command'],
  );
});

test('AD 카드 코드 표는 main 과 렌더러가 같다', () => {
  assert.deepEqual(rendererConstants.AD_CODE_BY_CLASS_MAP, mainNarrationClass.AD_CODE_BY_CLASS_MAP);
});

test('AD 카드 코드는 재생 분류마다 하나이고 아키텍처 순서(A1~A5)·화면 변화(A6)와 질문 답(Q)이다', () => {
  assert.deepEqual(mainNarrationClass.AD_CODE_BY_CLASS_MAP, {
    page_transition: 'A1',
    deixis: 'A2',
    speech_based: 'A3',
    silence_based: 'A4',
    speaker_identity: 'A5',
    screen_change: 'A6',
    user_command: 'Q',
  });
  assert.deepEqual(
    Object.keys(mainNarrationClass.AD_CODE_BY_CLASS_MAP).sort(),
    Object.values(mainNarrationTypes.NARRATION_CLASS_MAP).sort(),
  );
});

test('내레이션 유형 enum 은 main 과 렌더러가 같다', () => {
  assert.deepEqual(rendererConstants.NARRATION_TYPE_MAP, mainNarrationTypes.NARRATION_TYPE_MAP);
});

test('회의 요약 진행 단계 enum 은 main 과 렌더러가 같다', () => {
  assert.deepEqual(rendererConstants.SUMMARY_STAGE_MAP, mainSummaryGenerator.SUMMARY_STAGE_MAP);
});

test('디버그 단계 enum 은 main 과 렌더러가 같다', () => {
  assert.deepEqual(rendererConstants.DEBUG_STAGE_MAP, mainDebugEvents.DEBUG_STAGE_MAP);
});

test('값 검사 디버그 단계가 있고, 없앤 VLM 폴백 단계는 없다', () => {
  assert.equal(mainDebugEvents.DEBUG_STAGE_MAP.valueCheck, 'value_check');
  assert.equal(mainDebugEvents.DEBUG_STAGE_MAP.vlmFallback, undefined);
});

test('컨텍스트·질문 디버그 단계가 있다', () => {
  assert.equal(mainDebugEvents.DEBUG_STAGE_MAP.context, 'context');
  assert.equal(mainDebugEvents.DEBUG_STAGE_MAP.question, 'question');
});

test('무발화 디버그 단계가 있다', () => {
  assert.equal(mainDebugEvents.DEBUG_STAGE_MAP.silence, 'silence');
});

test('재생 대기 줄 디버그 단계가 있다', () => {
  assert.equal(mainDebugEvents.DEBUG_STAGE_MAP.queue, 'queue');
});

test('화면 변화 디버그 단계가 있다', () => {
  assert.equal(mainDebugEvents.DEBUG_STAGE_MAP.screenChange, 'screen_change');
});

test('화면 변화 하위 종류 표는 main 과 렌더러가 같다', () => {
  assert.deepEqual(rendererConstants.SCREEN_CHANGE_KIND_MAP, mainNarrationTypes.SCREEN_CHANGE_KIND_MAP);
});

test('기능 토글 디버그 단계가 있다', () => {
  assert.equal(mainDebugEvents.DEBUG_STAGE_MAP.toggle, 'toggle');
});
