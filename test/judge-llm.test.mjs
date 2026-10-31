import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const judgeLlmModule = require('../src/main/caption-pipeline/agents/shared/judge-llm.js');
const { createJudgeLlm, toChatMessageList, JUDGE_SOURCE_MAP } = judgeLlmModule;
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');

const gpuConfig = { judgeGpuUrl: 'http://gpu.test/v1/chat/completions', judgeGpuModel: 'judge-test' };

const fewShotMessageList = [
  { role: 'user', content: [{ text: '예시 입력' }] },
  { role: 'assistant', content: [{ text: '{"cue":true}' }] },
  { role: 'user', content: [{ text: '진짜 입력' }] },
];

function createGpuFetch({ content = '{"cue":true}', status = 200, error = null } = {}) {
  const callList = [];
  const fetchImpl = async (url, init) => {
    callList.push({ url, body: JSON.parse(init.body), hasSignal: Boolean(init.signal) });
    if (error) throw error;
    return { ok: status === 200, status, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return { fetchImpl, callList };
}

const request = { systemPrompt: '판정 규칙', messageList: fewShotMessageList, maxTokens: 300, timeoutMs: 15000, label: '시험' };

test('Converse 형식의 시스템 프롬프트·few-shot 을 OpenAI chat 메시지로 옮긴다', () => {
  assert.deepEqual(toChatMessageList({ systemPrompt: '규칙', messageList: fewShotMessageList }), [
    { role: 'system', content: '규칙' },
    { role: 'user', content: '예시 입력' },
    { role: 'assistant', content: '{"cue":true}' },
    { role: 'user', content: '진짜 입력' },
  ]);
  assert.equal(toChatMessageList({ systemPrompt: '', messageList: fewShotMessageList })[0].role, 'user');
});

test('판정은 GPU LLM 에 추론 없이(enable_thinking false) 온도 0 으로 묻고 gpu 경로를 남긴다', async () => {
  const gpu = createGpuFetch({ content: '{"cue":true,"reason":"presenting"}' });
  const judgeLlm = createJudgeLlm({ config: gpuConfig, fetchImpl: gpu.fetchImpl });
  const result = await judgeLlm.requestText(request);
  assert.deepEqual(result, { text: '{"cue":true,"reason":"presenting"}', source: JUDGE_SOURCE_MAP.gpu });
  const [call] = gpu.callList;
  assert.equal(call.url, gpuConfig.judgeGpuUrl);
  assert.equal(call.body.model, 'judge-test');
  assert.equal(call.body.temperature, 0);
  assert.equal(call.body.max_tokens, 300);
  assert.deepEqual(call.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(call.body.messages[0].role, 'system');
  assert.equal(call.body.messages.at(-1).content, '진짜 입력');
  assert.ok(call.hasSignal);
});

// GPU 판정이 실패하면 다른 서비스로 넘기지 않고 오류를 던진다(그 판정은 해설하지 않음으로 끝난다).
test('GPU 가 실패하거나 빈 답을 내면 다른 곳으로 넘기지 않고 오류를 던진다', async () => {
  for (const gpu of [createGpuFetch({ error: new Error('connect ECONNREFUSED') }), createGpuFetch({ content: '   ' }), createGpuFetch({ status: 503 })]) {
    const judgeLlm = createJudgeLlm({ config: gpuConfig, fetchImpl: gpu.fetchImpl });
    await assert.rejects(judgeLlm.requestText(request), /ECONNREFUSED|빈 응답|HTTP 503/);
    assert.equal(gpu.callList.length, 1);
  }
});

test('GPU 판정이 한 번 실패해도 다음 판정은 바로 GPU 로 간다(건너뛰는 창이 없다)', async () => {
  let isDown = true;
  const callList = [];
  const fetchImpl = async (url, init) => {
    callList.push(url);
    if (isDown) throw new Error('connect ECONNREFUSED');
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"cue":true}' } }] }) };
  };
  const judgeLlm = createJudgeLlm({ config: gpuConfig, fetchImpl });
  await assert.rejects(judgeLlm.requestText(request));
  isDown = false;
  assert.deepEqual(await judgeLlm.requestText(request), { text: '{"cue":true}', source: JUDGE_SOURCE_MAP.gpu });
  assert.equal(callList.length, 2);
  assert.equal('GPU_JUDGE_BYPASS_MS' in judgeLlmModule, false);
});

test('파이프라인 설정: VLM·GPU 판정은 같은 Gemma 4 26B-A4B 를 따로 띄운 것(8801·8805)이고 env 로 바꾼다', () => {
  const defaultConfig = readPipelineConfig({});
  assert.equal(defaultConfig.judgeGpuUrl, 'http://127.0.0.1:8805/v1/chat/completions');
  assert.equal(defaultConfig.judgeGpuModel, 'gemma-4-26b-a4b-qat');
  assert.equal(defaultConfig.vlmModel, 'gemma-4-26b-a4b-qat');
  assert.notEqual(defaultConfig.judgeGpuUrl, defaultConfig.vlmUrl);
  const customConfig = readPipelineConfig({
    SEEON_JUDGE_GPU_URL: 'http://x/v1/chat/completions', SEEON_JUDGE_GPU_MODEL: 'm',
  });
  assert.equal(customConfig.judgeGpuUrl, 'http://x/v1/chat/completions');
  assert.equal(customConfig.judgeGpuModel, 'm');
  assert.equal(readPipelineConfig({ SEEON_VLM_MODEL: 'v' }).vlmModel, 'v');
});

const { createUnifiedRouter, ROUTER_SOURCE_MAP } = require('../src/main/caption-pipeline/router/unified-router.js');
const { createSilenceJudge, SILENCE_JUDGE_SOURCE_MAP } = require('../src/main/caption-pipeline/router/silence-judge.js');
const { createDeixisJudgeClient } = require('../src/main/caption-pipeline/router/deixis-judge.js');

function createFakeJudgeLlm({ text, source = 'gpu', error = null }) {
  const requestList = [];
  return {
    requestList,
    requestText: async (judgeRequest) => {
      requestList.push(judgeRequest);
      if (error) throw error;
      return { text, source };
    },
  };
}

const triggerCandidate = { type: 'demonstrative', phrase: '이 막대', start: 0, end: 4 };

test('통합 라우터는 트리거 후보마다 판정 LLM 의 O/X 를 읽고 실제로 답한 경로(gpu)를 source 로 남긴다', async () => {
  const judgeLlm = createFakeJudgeLlm({ text: '{"judgeList":[{"id":1,"gap":"O","reason":"무엇인지 없다"}]}' });
  const router = createUnifiedRouter({ config: gpuConfig, judgeLlm });
  const routed = await router.route({ utterance: '이 막대를 보시면', before: '', after: '', candidateList: [triggerCandidate] });
  assert.equal(routed.source, ROUTER_SOURCE_MAP.gpu);
  assert.equal(routed.candidateList[0].type, 'deixis');
  assert.equal(routed.candidateList[0].anchor, '이 막대');
  assert.equal(routed.judgeList[0].isGap, true);
  assert.match(judgeLlm.requestList[0].messageList.at(-1).content[0].text, /이 막대를 보시면/);
  assert.match(judgeLlm.requestList[0].messageList.at(-1).content[0].text, /1\) \[지시대명사\] "이 막대"/);
  assert.ok(judgeLlm.requestList[0].systemPrompt.length > 0);
});

test('통합 라우터: 판정이 실패하거나 후보가 없으면 해설하지 않는다(최소 출력 원칙)', async () => {
  const unusedJudgeLlm = createFakeJudgeLlm({ text: '' });
  const noCandidateRouter = createUnifiedRouter({ config: gpuConfig, judgeLlm: unusedJudgeLlm });
  const noCandidate = await noCandidateRouter.route({ utterance: '이것', candidateList: [] });
  assert.equal(noCandidate.blockedReason, 'no_candidate');
  assert.equal(unusedJudgeLlm.requestList.length, 0);
  const originalError = console.error;
  console.error = () => {};
  try {
    const failingRouter = createUnifiedRouter({ config: gpuConfig, judgeLlm: createFakeJudgeLlm({ error: new Error('둘 다 실패') }) });
    const routed = await failingRouter.route({ utterance: '이것', candidateList: [triggerCandidate] });
    assert.equal(routed.source, ROUTER_SOURCE_MAP.error);
    assert.deepEqual(routed.candidateList, []);
    assert.equal(routed.blockedReason, 'judge_error');
  } finally {
    console.error = originalError;
  }
});

test('무발화 판정은 판정 LLM 의 답을 읽고 gpu 경로를 남긴다', async () => {
  const judgeLlm = createFakeJudgeLlm({ text: '{"cue": true, "reason": "presenting"}' });
  const silenceJudge = createSilenceJudge({ config: gpuConfig, judgeLlm });
  const verdict = await silenceJudge.judge({ transcript: '이 사진들을 한번 보시죠.', silenceMs: 5200 });
  assert.equal(verdict.hasCue, true);
  assert.equal(verdict.source, SILENCE_JUDGE_SOURCE_MAP.gpu);
});

test('지시 판정(judge 모드)도 판정 LLM 을 거치고 gpu 경로를 남긴다', async () => {
  const judgeLlm = createFakeJudgeLlm({ text: '{"caption": false, "reason": "abstract"}' });
  const deixisJudge = createDeixisJudgeClient({ config: gpuConfig, judgeLlm });
  const verdict = await deixisJudge.judge({ utterance: '이것은 중요합니다' });
  assert.equal(verdict.shouldCaption, false);
  assert.equal(verdict.source, 'gpu');
});
