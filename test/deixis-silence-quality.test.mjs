import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assembleNarration, hasCompleteTailNoun } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { buildGroundingPrompt } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { buildVisualDescriptionPrompt } = require('../src/main/caption-pipeline/prompts/visual-description.js');
const { wrapPlainSilenceContent } = require('../src/main/caption-pipeline/agents/visual-description-agent.js');
const {
  NARRATION_TYPE_MAP, DEIXIS_FORM_MAP, VISUAL_DESCRIPTION_KIND_MAP,
} = require('../src/main/caption-pipeline/contracts/narration-types.js');
const { NARRATION_ORIGIN_MAP } = require('../src/main/caption-pipeline/contracts/narration-class.js');

// QA 2-5: 지시 대상은 맞히는데 설명이 틀리거나(옆 상자 내용), 잘리거나("…도심 열의 약"), 어색한("보시는 중") AD 가 남아 있었다.
// QA 2-6: 무발화 묘사가 그래프 제목만 되풀이하거나 과정 그림의 용어만 말하고, 길게 쓴 좋은 묘사는 잘려 버려졌다.
const deixisSimple = (rawSlotMap) => assembleNarration({ narrationType: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.simple, rawSlotMap });
const deixisComplete = (rawSlotMap) => assembleNarration({ narrationType: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.complete, rawSlotMap });
const silence = (rawSlotMap) => assembleNarration({
  narrationType: NARRATION_TYPE_MAP.visualDescription, subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction,
  origin: NARRATION_ORIGIN_MAP.silence, rawSlotMap,
});

test('지시 상황 칸: "보시는 중·보이는 중·보며 설명함"은 청자 쪽 동작 "보는 중"으로 맞춘다', () => {
  for (const situation of ['보시는 중', '보이는 중', '보며 설명함', '보시며 설명함']) {
    assert.equal(deixisSimple({ target: '월별 매출 추이 표를', situation }).slotMap.situation, '보는 중', situation);
  }
  assert.equal(deixisSimple({ target: '월별 매출 추이 표를', situation: '비교 중' }).slotMap.situation, '비교 중');
});

test('지시 완전형 문장은 허용치(상한 + 2어절) 안이면 자르지 않고, 넘으면 지금처럼 상한에서 자른다', () => {
  const base = { mimicry: '여기 보시면', target: '도심 열', explanation: '냉방기 배출열 비중 표시' };
  const twelve = '여름에 특히 문제가 되는 냉방기 배출열은 도심 열의 약 25%를 차지함';
  assert.equal(deixisComplete({ ...base, sentence: twelve }).slotMap.sentence, twelve);
  const fourteen = '여름 한낮에 특히 문제가 되는 냉방기 배출열은 도심 열의 약 25%를 넘게 차지함';
  assert.equal(deixisComplete({ ...base, sentence: fourteen }).slotMap.sentence.split(' ').length <= 10, true, '허용치를 넘으면 상한 10어절에서 자른다');
});

test('"가장"은 자료 명사(장)로 끝맺은 것으로 보지 않는다', () => {
  assert.equal(hasCompleteTailNoun({ text: '9시 96건으로 가장 많고 19시 29건으로 가장' }), false);
  assert.equal(hasCompleteTailNoun({ text: '버스와 신호등을 찍은 사진 네 장' }), true);
});

test('무발화 묘사는 허용치(12 + 2어절) 안에서 자료 명사로 끝나면 중간에서 자르지 않고 통째로 받는다', () => {
  for (const description of [
    '9월 9시 96건으로 가장 많고 19시 29건으로 가장 적은 시간대별 평균 문의 접수량 막대그래프',
    '여덟 수를 두 그룹으로 나누어 각각 정복한 뒤 합쳐서 오름차순으로 다시 정렬한 그림',
  ]) {
    assert.equal(silence({ description }).slotMap.description, description);
  }
});

test('JSON 없이 쓴 무발화 묘사는 칸 하나짜리 JSON 으로 감싸 칸 규칙을 똑같이 쓴다(머리말·NONE·JSON·발화 기반은 그대로)', () => {
  assert.equal(
    wrapPlainSilenceContent({ content: '이미지 제시, 토요일 340명으로 가장 많은 막대그래프', origin: NARRATION_ORIGIN_MAP.silence }),
    JSON.stringify({ description: '토요일 340명으로 가장 많은 막대그래프' }),
  );
  assert.equal(wrapPlainSilenceContent({ content: 'NONE', origin: NARRATION_ORIGIN_MAP.silence }), 'NONE');
  assert.equal(wrapPlainSilenceContent({ content: '{"description":"표"}', origin: NARRATION_ORIGIN_MAP.silence }), '{"description":"표"}');
  assert.equal(wrapPlainSilenceContent({ content: '막대그래프', origin: NARRATION_ORIGIN_MAP.router }), '막대그래프');
});

test('지시 지시문은 대상 자신의 글자·수치만 쓰고 묶음은 개수로 말하게 하며, 무발화 지시문은 자료 종류마다 말할 것을 정한다', () => {
  const deixisPrompt = buildGroundingPrompt({ utterance: '여기 보시면', recentTranscript: '', maxChars: 80 });
  assert.match(deixisPrompt, /대상 자신에 붙은 글자·수치만 쓴다/);
  assert.match(deixisPrompt, /묶음 이름과 개수로 말한다/);
  assert.match(deixisPrompt, /화면 요소 이름으로 때우지 마라/);
  const silencePrompt = buildVisualDescriptionPrompt({ origin: NARRATION_ORIGIN_MAP.silence, minWordCount: 5, maxWordCount: 13 });
  assert.match(silencePrompt, /그래프·표: 가장 큰 값과 가장 작은 값/);
  assert.match(silencePrompt, /단계·과정 그림: 과정 이름·부제·용어/);
  assert.match(silencePrompt, /말만 바꿔 되풀이하면 실패다/);
  // 예시가 시연 영상의 낱말을 쓰면 그 화면에만 맞춘 지시문이 된다.
  for (const word of ['배송 지연', '영남', '냉방기', '제주', '불고기', '피벗', '합병', 'C-ITS']) {
    assert.equal(deixisPrompt.includes(word), false, `지시 지시문에 시연 낱말 ${word}`);
    assert.equal(silencePrompt.includes(word), false, `무발화 지시문에 시연 낱말 ${word}`);
  }
});
