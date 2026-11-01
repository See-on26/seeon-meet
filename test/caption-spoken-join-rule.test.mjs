import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  NARRATION_TYPE_MAP, DEIXIS_FORM_MAP, INTERPRETATION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP, SCREEN_CHANGE_KIND_MAP,
} = require('../src/main/caption-pipeline/contracts/narration-types.js');
const { NARRATION_ORIGIN_MAP } = require('../src/main/caption-pipeline/contracts/narration-class.js');
const { buildSlotOutputInstruction } = require('../src/main/caption-pipeline/agents/shared/caption-parser.js');
const { buildGroundingPrompt } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');
const { buildVisualDescriptionPrompt } = require('../src/main/caption-pipeline/prompts/visual-description.js');
const { buildScreenChangePrompt } = require('../src/main/caption-pipeline/prompts/screen-change.js');

// 해설 글은 음성으로 읽힌다. " - " 는 "마이너스"로, 괄호 속 영어 풀이는 소리 나는 대로 이어 읽혀 알아듣기 어렵다.
// 해설 에이전트가 함께 쓰는 출력 형식 안내에 한 번만 넣어 모든 해설 프롬프트가 같은 규칙을 받는다.
const RULE_MARK = '" - "로 가르거나';

function countOf(text, mark) {
  return text.split(mark).length - 1;
}

const KOREAN_CAPTION_PROMPT_CASE_LIST = [
  ['지시 단순형', () => buildGroundingPrompt({ utterance: '여기 보시면', subKind: DEIXIS_FORM_MAP.simple })],
  ['지시 완전형', () => buildGroundingPrompt({ utterance: '이거거든요', subKind: DEIXIS_FORM_MAP.complete })],
  ['해석 값→의미', () => buildInterpretationPrompt({ utterance: '73%입니다', subKind: INTERPRETATION_KIND_MAP.valueToMeaning })],
  ['해석 주장→값', () => buildInterpretationPrompt({ utterance: '크게 늘었습니다', subKind: INTERPRETATION_KIND_MAP.claimToValue })],
  ['시각 반응', () => buildVisualDescriptionPrompt({ subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction })],
  ['시각 척도', () => buildVisualDescriptionPrompt({ subKind: VISUAL_DESCRIPTION_KIND_MAP.scale, utterance: '정말 크죠' })],
  ['무발화 묘사', () => buildVisualDescriptionPrompt({
    subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction, origin: NARRATION_ORIGIN_MAP.silence,
  })],
  // 새 슬라이드(new_slide)는 앞선 해설을 다시 부른 기록의 갈래라 칸 형식이 없고, 출력 형식 안내도 붙지 않는다.
  ...[SCREEN_CHANGE_KIND_MAP.newText, SCREEN_CHANGE_KIND_MAP.highlight, SCREEN_CHANGE_KIND_MAP.visual]
    .map((eventKind) => [`화면 변화 ${eventKind}`, () => buildScreenChangePrompt({ eventKind })]),
];

for (const [label, build] of KOREAN_CAPTION_PROMPT_CASE_LIST) {
  test(`해설 프롬프트(${label}): 읽기 좋게 쉼표로 잇고 " - "·괄호 영어 풀이를 쓰지 말라는 규칙이 한 번 있다`, () => {
    const prompt = build();
    assert.equal(countOf(prompt, RULE_MARK), 1);
  });
}

test('출력 형식 안내: 한국어에는 읽기 규칙이 있고 쉼표로 이으라고 하며, 영어 안내에는 넣지 않는다', () => {
  const option = { narrationType: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.simple };
  const korean = buildSlotOutputInstruction(option);
  const ruleLine = korean.split('\n').find((line) => line.includes(RULE_MARK));
  assert.ok(ruleLine, '읽기 규칙 줄이 있다');
  assert.match(ruleLine, /괄호/);
  assert.match(ruleLine, /쉼표/);
  assert.equal(countOf(buildSlotOutputInstruction({ ...option, language: 'en' }), RULE_MARK), 0);
});
