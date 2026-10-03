import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODE_MAP, computeAnswerWordBudget, ANSWER_MAX_WORD_MAP } from '../src/renderer/core/mode/mode-policy.js';

test('질문 답 길이 상한은 품질 25 / 균형 15 / 성능·동시 12어절', () => {
  assert.equal(ANSWER_MAX_WORD_MAP[MODE_MAP.listening], 25);
  assert.equal(ANSWER_MAX_WORD_MAP[MODE_MAP.delayed], 15);
  assert.equal(ANSWER_MAX_WORD_MAP[MODE_MAP.realtimeSic], 12);
  assert.equal(ANSWER_MAX_WORD_MAP[MODE_MAP.realtimeMix], 12);
});

test('답 예산은 모드 상한을 쓰고 버리지 않는다', () => {
  assert.deepEqual(computeAnswerWordBudget({ mode: MODE_MAP.delayed }), { minWordCount: 3, maxWordCount: 15, isDroppable: false });
  assert.equal(computeAnswerWordBudget({ mode: 'unknown' }).maxWordCount, 12);
});
