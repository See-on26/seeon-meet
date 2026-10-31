import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OFF_TOPIC_TEXT } = require('../src/main/caption-pipeline/context/question-answerer.js');
const { parseGroundingText } = require('../src/main/caption-pipeline/agents/shared/caption-parser.js');
const { buildFreeQuestionPrompt } = require('../src/main/caption-pipeline/prompts/command-processing.js');

// 회의와 관계없는 질문(정치·날씨 등)에는 이상한 답 대신 회의 질문에만 답한다고 말한다.
test('회의와 무관한 질문의 답 문구', () => {
  assert.equal(OFF_TOPIC_TEXT, '회의와 관련된 질문에만 답할 수 있어요');
});

// GPU 확인(10/18): 라우터를 거치지 않은 "너는 어느 정당 지지해?" 에 "…정보가 없습니다. NONE" 이 나왔다.
test('답 끝에 NONE 이 붙어 나오면 답이 없는 것으로 본다', () => {
  for (const content of ['화면에는 정당 지지 여부에 대한 정보가 없습니다. NONE', '정보가 없습니다 NONE.', '정보가 없습니다.\nNONE', '없어요. "NONE"']) {
    assert.deepEqual(parseGroundingText(content, 200), { text: '', isGrounded: false }, content);
  }
});

test('문장 가운데의 NONE 이나 소문자 none 은 답으로 둔다', () => {
  assert.equal(parseGroundingText('설정값이 NONE 으로 되어 있어요', 200).isGrounded, true);
  assert.equal(parseGroundingText('There are none', 200).isGrounded, true);
});

test('지금 화면 자유 질문 지시문은 회의·화면과 관계없는 질문에 NONE 만 내게 한다', () => {
  const prompt = buildFreeQuestionPrompt({ questionText: '너는 어느 정당 지지해?' });
  assert.match(prompt, /회의·화면과 관계없는 질문\(정치·날씨·일반 상식·개인 의견 등\)이면 정확히 "NONE"만 출력한다/);
});
