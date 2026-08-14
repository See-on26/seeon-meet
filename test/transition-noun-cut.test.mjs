import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  cutAtTailNoun, normalizeSlotMap, getSlotList, hasCompleteTailNoun,
} = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { parsePageTransitionText } = require('../src/main/caption-pipeline/agents/page-transition-agent.js');
const { NARRATION_TYPE_MAP, PAGE_TRANSITION_KIND_MAP } = require('../src/main/caption-pipeline/contracts/narration-types.js');

const slideSlot = getSlotList({ narrationType: NARRATION_TYPE_MAP.pageTransition, subKind: PAGE_TRANSITION_KIND_MAP.slide })
  .find((slot) => slot.key === 'description');
const documentSlot = getSlotList({ narrationType: NARRATION_TYPE_MAP.pageTransition, subKind: PAGE_TRANSITION_KIND_MAP.document })
  .find((slot) => slot.key === 'description');

// 실회의(2026-10-03)에서 전환 고지가 탈락한 묘사 원문 3건.
const BOX_TEXT = '공정한 보상을 받습니다 제목과 기회 보상 설명 박스';
const BODY_GRAPH_TEXT = '반기와 수시 연봉 조정 방식을 설명한 본문과 연봉 변화 그래프';
const EVALUATION_TEXT = '에이블리다운 사람에게 더 많은 보상이 주어지는 평가 구조를 만드는 내용';

test('상한 안에서 조사를 뗀 뒤 자료 명사로 끝나는 가장 긴 지점에서 자른다', () => {
  assert.equal(cutAtTailNoun({ text: BODY_GRAPH_TEXT, maxWordCount: 7, minWordCount: 5 }), '반기와 수시 연봉 조정 방식을 설명한 본문');
  assert.equal(cutAtTailNoun({ text: '분기 매출 그래프와 지역별 비교 표가 함께 있는 화면 구성', maxWordCount: 6, minWordCount: 3 }), '분기 매출 그래프와 지역별 비교 표');
});

test('하한보다 짧아지면 자르지 않는다', () => {
  assert.equal(cutAtTailNoun({ text: '표를 보면 매출이 크게 늘어난 것을 알 수 있는', maxWordCount: 9, minWordCount: 6 }), null);
});

test('자료 명사가 없으면 null', () => {
  assert.equal(cutAtTailNoun({ text: '여러 가지 이야기를 하고 있는 중인', maxWordCount: 9, minWordCount: 3 }), null);
});

test('박스·평가 같은 낱말도 자료 명사로 본다', () => {
  assert.equal(hasCompleteTailNoun({ text: BOX_TEXT }), true);
  assert.equal(hasCompleteTailNoun({ text: '보상이 주어지는 평가' }), true);
  assert.equal(hasCompleteTailNoun({ text: '연봉 조정 제도' }), true);
});

test('실회의 탈락 3건이 모두 상한 안의 완결 묘사로 살아난다', () => {
  assert.equal(normalizeSlotMap({ slotList: [slideSlot], rawSlotMap: { description: BOX_TEXT } }).description, BOX_TEXT);
  assert.equal(normalizeSlotMap({ slotList: [documentSlot], rawSlotMap: { description: BODY_GRAPH_TEXT } }).description,
    '반기와 수시 연봉 조정 방식을 설명한 본문');
  assert.equal(normalizeSlotMap({ slotList: [documentSlot], rawSlotMap: { description: EVALUATION_TEXT } }).description,
    '에이블리다운 사람에게 더 많은 보상이 주어지는 평가');
});

test('자료 명사로 끝나는 묘사는 지금처럼 상한 +2어절까지 그대로 둔다', () => {
  const elevenWordText = '반기와 수시 연봉 조정 방식을 설명한 본문과 연봉 변화 그래프 자료';
  assert.equal(normalizeSlotMap({ slotList: [slideSlot], rawSlotMap: { description: elevenWordText } }).description, elevenWordText);
});

test('문서형 전환 고지가 잘린 묘사로 만들어진다', () => {
  const result = parsePageTransitionText(JSON.stringify({
    screenType: 'doc', screenForm: 'PDF 문서', pageTopic: '연봉 조정', description: BODY_GRAPH_TEXT,
  }));
  assert.equal(result.description, '반기와 수시 연봉 조정 방식을 설명한 본문');
  assert.equal(result.narration, 'PDF 문서, 반기와 수시 연봉 조정 방식을 설명한 본문', '묘사에 형태가 없으면 형태를 앞에 붙인다');
});
