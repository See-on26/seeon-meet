import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MODE_MAP, computeAnswerWordBudget, ANSWER_MAX_WORD_COUNT } from '../src/renderer/core/mode/mode-policy.js';

const require = createRequire(import.meta.url);
const { buildCommandPrompt, buildFreeQuestionPrompt } = require('../src/main/caption-pipeline/prompts/command-processing.js');
const { buildMeetingFlowPrompt } = require('../src/main/caption-pipeline/prompts/question-answer.js');

// TTS 는 어절당 약 0.45초라 30어절이면 약 13초다. 질문 답은 모드와 관계없이 15초를 넘지 않게 한다.
test('질문 답 길이 상한은 모든 모드에서 30어절(15초 미만)이다', () => {
  assert.equal(ANSWER_MAX_WORD_COUNT, 30);
  for (const mode of Object.values(MODE_MAP)) {
    assert.deepEqual(computeAnswerWordBudget({ mode }), { minWordCount: 3, maxWordCount: 30, isDroppable: false });
  }
  assert.equal(computeAnswerWordBudget({ mode: 'unknown' }).maxWordCount, 30);
});

test('질문 답 프롬프트는 1~2문장, 짧게 답할 수 있는 질문은 한 문장으로 답하게 한다', () => {
  const promptList = [
    buildCommandPrompt({ command: 'screen_material', minWordCount: 3, maxWordCount: 30 }),
    buildFreeQuestionPrompt({ questionText: '이 그래프 단위가 뭐야?', minWordCount: 3, maxWordCount: 30 }),
    buildMeetingFlowPrompt({ questionText: '지금까지 무슨 얘기야?', flowText: '-', minWordCount: 3, maxWordCount: 30 }),
  ];
  for (const prompt of promptList) {
    assert.match(prompt, /1~2문장/);
    assert.match(prompt, /한 문장으로 짧게/);
  }
});
