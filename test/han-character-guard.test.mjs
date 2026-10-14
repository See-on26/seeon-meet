import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseSlotCaption, buildSlotOutputInstruction, containsHanCharacter } = require('../src/main/caption-pipeline/agents/shared/caption-parser.js');
const { parsePageTransitionText, buildPageTransitionPrompt } = require('../src/main/caption-pipeline/agents/page-transition-agent.js');

test('한자(중국어 글자)가 섞였는지 가린다', () => {
  assert.equal(containsHanCharacter('일식 5명中式 10명'), true);
  assert.equal(containsHanCharacter('한식 5명 양식 10명 중식 10명'), false);
  assert.equal(containsHanCharacter('Q4 sales, 182 million won'), false);
});

test('VLM 해설에 한자가 섞이면 내보내지 않는다(Qwen 이 "중식"을 "中式"으로 바꿔 쓴 실제 사례)', () => {
  const content = '{"description": "한식 5명 양식 10명 일식 5명中式 10명 막대그래프"}';
  const result = parseSlotCaption({ content, narrationType: 'visual_description', subKind: 'reaction', maxChars: 80, maxWordCount: 12 });
  assert.equal(result.isGrounded, false);
  assert.equal(result.text, '');
});

test('한자가 없는 해설은 그대로 낸다', () => {
  const content = '{"description": "한식 5명 양식 10명 중식 10명 막대그래프"}';
  const result = parseSlotCaption({ content, narrationType: 'visual_description', subKind: 'reaction', maxChars: 80, maxWordCount: 12 });
  assert.equal(result.isGrounded, true);
  assert.equal(result.text, '이미지 제시, 한식 5명 양식 10명 중식 10명 막대그래프');
});

test('JSON 이 아닌 자유 문장 해설도 한자가 섞이면 내보내지 않는다', () => {
  const result = parseSlotCaption({ content: '메뉴 中式 가격표', narrationType: 'visual_description', subKind: 'reaction', maxChars: 80, maxWordCount: 12 });
  assert.equal(result.isGrounded, false);
});

test('해설 출력 형식 안내와 전환 프롬프트에 한자·중국어를 섞지 말라는 규칙이 있다', () => {
  assert.match(buildSlotOutputInstruction({ narrationType: 'visual_description', subKind: 'reaction' }), /한자·중국어/);
  assert.match(buildPageTransitionPrompt({}), /한자·중국어/);
});

test('전환 해설에 한자가 섞이면 고지하지 않고 사유를 남긴다', () => {
  const parsed = parsePageTransitionText('{"screenType": "ppt", "pageNumber": null, "pageTopic": "메뉴", "description": "주방별 中式 메뉴 가격을 정리한 표"}');
  assert.equal(parsed.narration, '');
  assert.equal(parsed.rejectedReason, 'han');
  const clean = parsePageTransitionText('{"screenType": "ppt", "pageNumber": null, "pageTopic": "메뉴", "description": "주방별 메인 메뉴 가격을 정리한 표"}');
  assert.equal(clean.narration, '주방별 메인 메뉴 가격을 정리한 표');
  assert.equal(clean.rejectedReason, null);
});
