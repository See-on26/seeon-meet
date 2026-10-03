import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createSilenceJudge, parseSilenceJudgeText, SILENCE_JUDGE_SOURCE_MAP,
} = require('../src/main/caption-pipeline/router/silence-judge.js');
const { SILENCE_REASON_MAP } = require('../src/main/caption-pipeline/prompts/silence-judge.js');

const config = { judgeModelId: 'anthropic.claude-sonnet-5', bedrockApiKey: 'key', bedrockRegion: 'us-east-1' };

test('cue 가 true 일 때만 단서 있음으로 본다', () => {
  assert.deepEqual(parseSilenceJudgeText('{"cue": true, "reason": "presenting"}'), {
    hasCue: true, reason: SILENCE_REASON_MAP.presenting,
  });
  assert.equal(parseSilenceJudgeText('{"cue": false, "reason": "ending"}').hasCue, false);
});

test('형식이 어긋나면 애매한 것으로 보고 차단한다', () => {
  assert.equal(parseSilenceJudgeText('true').hasCue, false);
  assert.equal(parseSilenceJudgeText('{"cue": "true"}').hasCue, false);
  assert.equal(parseSilenceJudgeText('').hasCue, false);
  assert.equal(parseSilenceJudgeText(null).hasCue, false);
});

test('코드 블록으로 감싼 JSON 도 읽는다', () => {
  assert.equal(parseSilenceJudgeText('```json\n{"cue": true, "reason": "presenting"}\n```').hasCue, true);
});

test('직전 발화가 비어 있으면 모델을 부르지 않고 차단한다', async () => {
  let callCount = 0;
  const judge = createSilenceJudge({ config, requestConverse: async () => { callCount += 1; return { text: '' }; } });
  const verdict = await judge.judge({ transcript: '   ', silenceMs: 5000 });
  assert.equal(verdict.hasCue, false);
  assert.equal(verdict.source, SILENCE_JUDGE_SOURCE_MAP.empty);
  assert.equal(callCount, 0);
});

test('판정 모델(judgeModelId)에 직전 발화와 무음 길이를 보낸다', async () => {
  let request = null;
  const judge = createSilenceJudge({
    config,
    requestConverse: async (args) => { request = args; return { text: '{"cue": true, "reason": "presenting"}' }; },
  });
  const verdict = await judge.judge({ transcript: '여러분, 이 사진을 한번 보시죠.', silenceMs: 5200 });
  assert.equal(verdict.hasCue, true);
  assert.equal(verdict.source, SILENCE_JUDGE_SOURCE_MAP.bedrock);
  assert.equal(request.modelId, config.judgeModelId);
  assert.ok(Number.isFinite(request.timeoutMs));
  // Sonnet 5 는 답 전에 숨은 추론으로 100~200토큰을 쓴다. 상한이 작으면 빈 답이 와서 단서가 있어도 차단된다.
  assert.ok(request.maxTokens >= 400);
  const lastMessage = request.messageList[request.messageList.length - 1];
  assert.equal(lastMessage.role, 'user');
  assert.match(lastMessage.content[0].text, /이 사진을 한번 보시죠/);
  assert.match(lastMessage.content[0].text, /5초/);
});

test('모델 호출이 실패하면 차단한다', async () => {
  const judge = createSilenceJudge({
    config, requestConverse: async () => { throw new Error('Bedrock HTTP 500'); },
  });
  const verdict = await judge.judge({ transcript: '이 그래프를 보시면요.', silenceMs: 5000 });
  assert.equal(verdict.hasCue, false);
  assert.equal(verdict.source, SILENCE_JUDGE_SOURCE_MAP.error);
  assert.match(verdict.reason, /500/);
});

const { SILENCE_JUDGE_SYSTEM_PROMPT, SILENCE_FEW_SHOT_LIST } = require('../src/main/caption-pipeline/prompts/silence-judge.js');

test('단서는 침묵 바로 앞 마지막 문장에 있어야 한다 — 보라고 한 뒤 다른 얘기로 넘어갔으면 차단 예시가 있다', () => {
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /마지막 문장/);
  const movedOnExample = SILENCE_FEW_SHOT_LIST.find((example) => /보시죠/.test(example.input.transcript) && !example.output.cue);
  assert.ok(movedOnExample);
});
