import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROUTER_PROMPT_MAP } = require('../src/main/caption-pipeline/prompts/unified-router.js');
const { JUDGE_SYSTEM_PROMPT } = require('../src/main/caption-pipeline/prompts/deixis-judge.js');
const { SILENCE_JUDGE_SYSTEM_PROMPT } = require('../src/main/caption-pipeline/prompts/silence-judge.js');

// 정보 공백 해설(지시·발화·무발화)은 최소 출력 원칙을 따른다: 애매하면 내보내지 않는다.
for (const [name, prompt] of [
  ['지시 대상 판단', ROUTER_PROMPT_MAP.deixis.systemPrompt], ['발화 기반 판단', ROUTER_PROMPT_MAP.speech.systemPrompt],
  ['지시 판정기', JUDGE_SYSTEM_PROMPT],
]) {
  test(`${name}는 애매하면 내보내지 않는다`, () => {
    assert.match(prompt, /애매하면 내보내지 않는다/);
    assert.doesNotMatch(prompt, /확신이 없으면 (통과|caption=true)/);
    assert.doesNotMatch(prompt, /놓치는 것보다 통과가 낫다/);
  });
}

// 판정기 v2(10/18): 화면을 보라는 말(①), 화면 속 문제·퀴즈를 풀어 보라는 말(②), 화면에 띄운 것을 짧게 소개하고 멈춘 말(③)만 통과.
test('무발화 판정기는 화면으로 눈을 이끈 세 경우만 통과시키고 그 밖은 차단한다', () => {
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /위 ①②③에 들지 않으면 cue=false 로 차단한다/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /화면을 보세요/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /화면에 띄운 문제·퀴즈·퍼즐을 보고 풀거나 찾아보라고 함/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /화면에 띄운 것을 가리켜 짧게 소개하고 멈춤/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /음·어/);
});

test('무발화 판정기는 "보다·look"이 들어간 함정 표현(들어 보시죠·look into)을 단서로 보지 않는다', () => {
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /들어 보시죠/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /look into/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /Take a look at the chart/);
});
