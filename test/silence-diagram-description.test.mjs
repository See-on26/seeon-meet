import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  MODE_MAP, computeWordBudget, computeSilenceWordBudget, SILENCE_DESCRIPTION_WORD_RANGE,
} from '../src/renderer/core/mode/mode-policy.js';

const require = createRequire(import.meta.url);
const { buildVisualDescriptionPrompt } = require('../src/main/caption-pipeline/prompts/visual-description.js');
const { getSlotList, hasCompleteTailNoun } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { parseSlotCaption } = require('../src/main/caption-pipeline/agents/shared/caption-parser.js');
const { finalizeSilenceDescription } = require('../src/main/caption-pipeline/orchestrator/silence-narrator.js');
const { NARRATION_ORIGIN_MAP } = require('../src/main/caption-pipeline/contracts/narration-class.js');
const { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP } = require('../src/main/caption-pipeline/contracts/narration-types.js');

const visualDescription = NARRATION_TYPE_MAP.visualDescription;
const reaction = VISUAL_DESCRIPTION_KIND_MAP.reaction;
const silence = NARRATION_ORIGIN_MAP.silence;

// 실제 시연(10/15)에서 "다이어그램을 잠시 살펴보시죠" 뒤 "이미지 제시, C-ITS 시스템 구조도 다이어그램"만 나왔다.
// 구조도는 구성 요소와 연결 관계까지 말해야 청자가 무엇을 보는지 안다(11어절).
const DIAGRAM_DESCRIPTION = '노변 기지국을 중심으로 차량 단말기와 ITS 센터가 무선과 광통신망으로 연결된 구조도';

test('무발화 묘사 칸은 구조도의 구성 요소·연결 관계까지 담게 12어절까지 받고, 사진 반응 묘사 칸은 8어절 그대로다', () => {
  const [silenceSlot] = getSlotList({ narrationType: visualDescription, subKind: reaction, origin: silence });
  assert.equal(silenceSlot.maxWordCount, 12);
  assert.match(silenceSlot.label, /구성 요소/);
  const [reactionSlot] = getSlotList({ narrationType: visualDescription, subKind: reaction });
  assert.equal(reactionSlot.maxWordCount, 8);
});

test('무발화 묘사는 11어절 구조도 묘사를 자르지 않고 조립하고, 사진 반응 묘사는 지금처럼 8어절에서 자른다', () => {
  const content = JSON.stringify({ description: DIAGRAM_DESCRIPTION });
  const silenceResult = parseSlotCaption({
    content, narrationType: visualDescription, subKind: reaction, origin: silence, maxChars: 80, maxWordCount: 14,
  });
  assert.equal(silenceResult.text, `이미지 제시, ${DIAGRAM_DESCRIPTION}`);
  const reactionResult = parseSlotCaption({
    content, narrationType: visualDescription, subKind: reaction, maxChars: 80, maxWordCount: 12,
  });
  assert.notEqual(reactionResult.text, `이미지 제시, ${DIAGRAM_DESCRIPTION}`);
});

test('구조도·구성도·개념도 같은 도식 이름도 자료 명사로 끝맺은 것으로 본다', () => {
  assert.equal(finalizeSilenceDescription({ text: `이미지 제시, ${DIAGRAM_DESCRIPTION}` }), `이미지 제시, ${DIAGRAM_DESCRIPTION}`);
  for (const noun of ['구조도', '구성도', '개념도', '모식도', '관계도', '계통도', '체계도', '배치도', '설계도', '도면']) {
    assert.equal(hasCompleteTailNoun({ text: `서비스 연결 ${noun}` }), true, noun);
  }
});

test('무발화 프롬프트는 구조도·흐름도면 제목 대신 구성 요소와 연결 관계를 묘사하게 하고, 칸 길이를 12어절로 알린다', () => {
  const prompt = buildVisualDescriptionPrompt({
    subKind: reaction, origin: silence, recentTranscript: '다이어그램을 잠시 살펴보시죠.', minWordCount: 5, maxWordCount: 14,
  });
  // 무발화 v3: 구조도는 주요 구성 요소와 연결을 담고, 화면 제목은 뺀다.
  assert.match(prompt, /구조도는 주요 구성 요소와 연결/);
  assert.match(prompt, /빼는 것: 화면 제목/);
  assert.match(prompt, /3~12어절/);
  assert.match(buildVisualDescriptionPrompt({ subKind: reaction }), /3~8어절/);
});

test('무발화 프롬프트 예시에 시연 슬라이드 내용을 넣지 않는다(모델이 답을 베끼지 않게)', () => {
  const prompt = buildVisualDescriptionPrompt({ subKind: reaction, origin: silence });
  assert.doesNotMatch(prompt, /노변|기지국|C-ITS|ITS 센터|광통신/);
});

test('무발화 해설 어절 예산은 사진 반응보다 길게(최대 14어절) 잡고, 모드가 낼 수 있는 길이를 넘지 않는다', () => {
  assert.deepEqual(SILENCE_DESCRIPTION_WORD_RANGE, { minWordCount: 5, maxWordCount: 14 });
  assert.equal(computeWordBudget({ mode: MODE_MAP.delayed, narrationType: 'visual_description', subKind: 'reaction' }).maxWordCount, 12);
  assert.deepEqual(computeSilenceWordBudget({ mode: MODE_MAP.delayed }), { minWordCount: 5, maxWordCount: 13, isDroppable: false });
  assert.deepEqual(computeSilenceWordBudget({ mode: MODE_MAP.listening }), { minWordCount: 5, maxWordCount: 14, isDroppable: false });
  assert.deepEqual(computeSilenceWordBudget({ mode: MODE_MAP.realtimeSic }), { minWordCount: 5, maxWordCount: 6, isDroppable: false });
});

test('제품 화면은 무발화 해설에 무발화 예산을 쓰고, 시각묘사 에이전트는 무발화 칸으로 읽는다', () => {
  const mainSource = fs.readFileSync(new URL('../src/renderer/app/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /const wordBudget = computeSilenceWordBudget\(\{ mode: getCurrentMode\(\) \}\);/);
  const agentSource = fs.readFileSync(new URL('../src/main/caption-pipeline/agents/visual-description-agent.js', import.meta.url), 'utf8');
  assert.match(agentSource, /parseSlotCaption\(\{[^}]*origin,?[^}]*\}\)/);
});
