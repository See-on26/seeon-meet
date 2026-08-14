import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toNarrationClass, NARRATION_ORIGIN_MAP } = require('../src/main/caption-pipeline/contracts/narration-class.js');

test('페이지 전환 source 문자열은 page_transition', () => {
  assert.equal(toNarrationClass({ narrationType: 'page-transition' }), 'page_transition');
  assert.equal(toNarrationClass({ narrationType: 'page_transition' }), 'page_transition');
});

test('지시·해석·화자·명령은 유형대로 분류된다', () => {
  assert.equal(toNarrationClass({ narrationType: 'deixis' }), 'deixis');
  assert.equal(toNarrationClass({ narrationType: 'interpretation' }), 'speech_based');
  assert.equal(toNarrationClass({ narrationType: 'speaker_identity' }), 'speaker_identity');
  assert.equal(toNarrationClass({ narrationType: 'user_command' }), 'user_command');
});

test('시각 묘사는 출처에 따라 분류가 갈린다', () => {
  assert.equal(toNarrationClass({ narrationType: 'visual_description' }), 'speech_based');
  assert.equal(toNarrationClass({
    narrationType: 'visual_description', origin: NARRATION_ORIGIN_MAP.pageTransition,
  }), 'page_transition');
  assert.equal(toNarrationClass({
    narrationType: 'visual_description', origin: NARRATION_ORIGIN_MAP.silence,
  }), 'silence_based');
});

test('화면 변화 해설은 화면 변화 분류다', () => {
  assert.equal(toNarrationClass({ narrationType: 'screen_change' }), 'screen_change');
});

test('모르는 유형은 null', () => {
  assert.equal(toNarrationClass({ narrationType: 'unknown' }), null);
  assert.equal(toNarrationClass({ narrationType: undefined }), null);
});
