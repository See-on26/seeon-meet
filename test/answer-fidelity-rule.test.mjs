import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAnswerLengthRule } = require('../src/main/caption-pipeline/prompts/answer-length-rule.js');
const { buildFreeQuestionPrompt } = require('../src/main/caption-pipeline/prompts/command-processing.js');
const {
  buildPastSlideAnswerPrompt, buildImageAnswerPrompt, buildSpeakerAnswerPrompt, buildMeetingFlowPrompt,
} = require('../src/main/caption-pipeline/prompts/question-answer.js');

// 질문 답이 "짧게"만 따르면 화면의 규칙·조건에서 조건 절이 빠지고("~면 ~해야 한다" → "~해야 한다"),
// 항목 밑의 위치 표지(A·B·C·D)를 내용처럼 읽는다. 지금 화면 답과 기록 답 모두 충실 규칙을 받는다.
const ANSWER_PROMPT_CASE_LIST = [
  ['지금 화면 답', () => buildFreeQuestionPrompt({ questionText: '규칙이 정확히 뭐였지?', minWordCount: 3, maxWordCount: 30 })],
  ['지난 화면 답(그림 있음)', () => buildPastSlideAnswerPrompt({
    questionText: 'q', evidenceText: 'e', minWordCount: 3, maxWordCount: 30, hasImage: true,
  })],
  ['지난 화면 답(그림 없음)', () => buildPastSlideAnswerPrompt({ questionText: 'q', evidenceText: 'e', minWordCount: 3, maxWordCount: 30 })],
  ['지난 화면 그림 답', () => buildImageAnswerPrompt({ questionText: 'q', evidenceText: 'e', minWordCount: 3, maxWordCount: 30 })],
  ['화자 답', () => buildSpeakerAnswerPrompt({ questionText: 'q', utteranceText: 'u', minWordCount: 3, maxWordCount: 30 })],
  ['회의 흐름 답', () => buildMeetingFlowPrompt({ questionText: 'q', flowText: 'f', minWordCount: 3, maxWordCount: 30 })],
];

for (const [label, build] of ANSWER_PROMPT_CASE_LIST) {
  test(`충실 규칙(${label}): 조항·조건 짜임을 지키고, 화면 문구를 그대로 옮기고, 위치 표지는 묻지 않으면 말하지 않는다`, () => {
    const prompt = build();
    assert.match(prompt, /모든 조항을 빠짐없이/);
    assert.match(prompt, /조건\(~면·~다면·~일 때\)과 결과/);
    assert.match(prompt, /화면 문구를 그대로 옮긴다/);
    assert.match(prompt, /위치 표지와 슬라이드 번호는 질문이 그것을 묻거나/);
    assert.match(prompt, /규칙·조건·절차·정의를 묻는 질문은 짧게 줄이지 않는다/);
    // 예시는 일반 문장으로 둔다. 평가 영상의 규칙 문구를 프롬프트에 넣으면 평가 자료에 맞춘 조정이 된다.
    assert.doesNotMatch(prompt, /모음|홀수|뒷면/);
  });
}

test('길이 규칙: 1~2문장·짧은 답 규칙은 그대로 두고, 규칙·조건을 묻는 질문은 줄이지 않는다는 문장을 덧붙인다', () => {
  const rule = buildAnswerLengthRule({ minWordCount: 3, maxWordCount: 30, maxChars: 135 });
  assert.match(rule, /^3~30어절, 1~2문장으로 답한다 \(최대 135자\)\. /);
  assert.match(rule, /한 문장으로 짧게 답한다\. /);
  assert.match(rule, /조건과 결과를 모두 담아 2문장까지 쓴다\.$/);
});

test('지금 화면 답: 화면과 함께 기록(발표자의 말)도 근거로 쓴다', () => {
  const prompt = buildFreeQuestionPrompt({ questionText: 'q', minWordCount: 3, maxWordCount: 30 });
  assert.match(prompt, /\(1\) 화면과 위 기록\(발표자의 말 포함\)에 근거해 답한다\. 지어내지 않는다\./);
  assert.match(prompt, /\(4\) 화면 글자와 발표자의 말을 옮길 때:/);
  assert.match(prompt, /\(5\) 머리말·인사말 없이 답만 출력한다\./);
  assert.match(prompt, /\(6\) 이미 안내했던 내용이라도/);
});

test('기록 답: 충실 규칙은 (4), 그림이 있을 때의 이미지 요청 규칙은 (5)다', () => {
  const prompt = buildPastSlideAnswerPrompt({ questionText: 'q', evidenceText: 'e', minWordCount: 3, maxWordCount: 30, hasImage: true });
  assert.match(prompt, /\(4\) 화면 글자와 발표자의 말을 옮길 때:/);
  assert.match(prompt, /\(5\) 색·배치·모양처럼 화면 그림을 봐야 답할 수 있는 질문도 정확히 "NEED_IMAGE"만 출력한다\./);
});
