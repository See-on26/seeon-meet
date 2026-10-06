import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createJudgeLlm, toChatMessageList, JUDGE_SOURCE_MAP, GPU_JUDGE_BYPASS_MS,
} = require('../src/main/caption-pipeline/agents/shared/judge-llm.js');
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');

const gpuConfig = {
  judgeBackend: 'gpu', judgeGpuUrl: 'http://gpu.test/v1/chat/completions', judgeGpuModel: 'qwen-test',
  judgeModelId: 'anthropic.claude-sonnet-5', bedrockApiKey: 'key', bedrockRegion: 'us-east-1',
};

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

function createConverse({ text = '{"cue":false}', error = null } = {}) {
  const callList = [];
  const requestConverse = async (args) => {
    callList.push(args);
    if (error) throw error;
    return { text };
  };
  return { requestConverse, callList };
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

test('GPU 백엔드면 GPU LLM 에 추론 없이(enable_thinking false) 온도 0 으로 묻고 gpu 경로를 남긴다', async () => {
  const gpu = createGpuFetch({ content: '{"cue":true,"reason":"presenting"}' });
  const converse = createConverse();
  const judgeLlm = createJudgeLlm({ config: gpuConfig, fetchImpl: gpu.fetchImpl, requestConverse: converse.requestConverse });
  const result = await judgeLlm.requestText(request);
  assert.deepEqual(result, { text: '{"cue":true,"reason":"presenting"}', source: JUDGE_SOURCE_MAP.gpu });
  assert.equal(converse.callList.length, 0);
  const [call] = gpu.callList;
  assert.equal(call.url, gpuConfig.judgeGpuUrl);
  assert.equal(call.body.model, 'qwen-test');
  assert.equal(call.body.temperature, 0);
  assert.equal(call.body.max_tokens, 300);
  assert.deepEqual(call.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(call.body.messages[0].role, 'system');
  assert.equal(call.body.messages.at(-1).content, '진짜 입력');
  assert.ok(call.hasSignal);
});

test('GPU 가 실패하면 같은 판정을 Bedrock(judgeModelId)으로 보내고, 잠시 GPU 를 건너뛴다', async () => {
  let nowMs = 1000;
  const gpu = createGpuFetch({ error: new Error('connect ECONNREFUSED') });
  const converse = createConverse({ text: '{"cue":false}' });
  const judgeLlm = createJudgeLlm({
    config: gpuConfig, fetchImpl: gpu.fetchImpl, requestConverse: converse.requestConverse, now: () => nowMs, log: () => {},
  });
  assert.deepEqual(await judgeLlm.requestText(request), { text: '{"cue":false}', source: JUDGE_SOURCE_MAP.bedrock });
  assert.equal(converse.callList[0].modelId, gpuConfig.judgeModelId);
  assert.equal(converse.callList[0].systemPrompt, '판정 규칙');
  assert.equal(converse.callList[0].messageList, fewShotMessageList);

  nowMs += GPU_JUDGE_BYPASS_MS - 1;
  await judgeLlm.requestText(request);
  assert.equal(gpu.callList.length, 1, '우회 창 안에서는 GPU 를 부르지 않는다');

  nowMs += 2;
  await judgeLlm.requestText(request);
  assert.equal(gpu.callList.length, 2, '우회 창이 지나면 다시 GPU 를 먼저 부른다');
});

test('GPU 가 빈 답이나 HTTP 오류를 내도 Bedrock 으로 넘긴다', async () => {
  for (const gpu of [createGpuFetch({ content: '   ' }), createGpuFetch({ status: 503 })]) {
    const converse = createConverse({ text: '{"cue":true}' });
    const judgeLlm = createJudgeLlm({ config: gpuConfig, fetchImpl: gpu.fetchImpl, requestConverse: converse.requestConverse, log: () => {} });
    assert.equal((await judgeLlm.requestText(request)).source, JUDGE_SOURCE_MAP.bedrock);
  }
});

test('Bedrock 키가 없으면 GPU 실패를 그대로 던진다', async () => {
  const judgeLlm = createJudgeLlm({
    config: { ...gpuConfig, bedrockApiKey: '' }, fetchImpl: createGpuFetch({ status: 500 }).fetchImpl, log: () => {},
  });
  await assert.rejects(judgeLlm.requestText(request), /HTTP 500/);
});

test('GPU·Bedrock 둘 다 실패하면 두 오류를 함께 담아 던진다', async () => {
  const judgeLlm = createJudgeLlm({
    config: gpuConfig, fetchImpl: createGpuFetch({ status: 500 }).fetchImpl,
    requestConverse: createConverse({ error: new Error('Bedrock 403') }).requestConverse, log: () => {},
  });
  await assert.rejects(judgeLlm.requestText(request), /HTTP 500.*Bedrock 403/);
});

test('bedrock 백엔드거나 백엔드가 지정되지 않은 설정은 GPU 를 부르지 않는다', async () => {
  for (const config of [{ ...gpuConfig, judgeBackend: 'bedrock' }, { ...gpuConfig, judgeBackend: undefined }]) {
    const gpu = createGpuFetch();
    const converse = createConverse({ text: '{"cue":true}' });
    const judgeLlm = createJudgeLlm({ config, fetchImpl: gpu.fetchImpl, requestConverse: converse.requestConverse });
    assert.equal((await judgeLlm.requestText(request)).source, JUDGE_SOURCE_MAP.bedrock);
    assert.equal(gpu.callList.length, 0);
  }
});

test('파이프라인 설정: 판정 백엔드는 기본 gpu, GPU 판정은 VLM 과 따로 띄운 Qwen3.5-9B(8805)이고 env 로 바꾼다', () => {
  const defaultConfig = readPipelineConfig({});
  assert.equal(defaultConfig.judgeBackend, 'gpu');
  assert.equal(defaultConfig.judgeGpuUrl, 'http://127.0.0.1:8805/v1/chat/completions');
  assert.equal(defaultConfig.judgeGpuModel, 'qwen3.5-9b');
  assert.notEqual(defaultConfig.judgeGpuUrl, defaultConfig.vlmUrl);
  const customConfig = readPipelineConfig({
    SEEON_JUDGE_BACKEND: 'bedrock', SEEON_JUDGE_GPU_URL: 'http://x/v1/chat/completions', SEEON_JUDGE_GPU_MODEL: 'm',
  });
  assert.equal(customConfig.judgeBackend, 'bedrock');
  assert.equal(customConfig.judgeGpuUrl, 'http://x/v1/chat/completions');
  assert.equal(customConfig.judgeGpuModel, 'm');
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(readPipelineConfig({ SEEON_JUDGE_BACKEND: 'openai' }).judgeBackend, 'gpu');
  } finally {
    console.warn = originalWarn;
  }
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
  const router = createUnifiedRouter({ config: { ...gpuConfig, bedrockApiKey: '' }, judgeLlm });
  const routed = await router.route({ utterance: '이 막대를 보시면', before: '', after: '', candidateList: [triggerCandidate] });
  assert.equal(routed.source, ROUTER_SOURCE_MAP.gpu);
  assert.equal(routed.candidateList[0].type, 'deixis');
  assert.equal(routed.candidateList[0].anchor, '이 막대');
  assert.equal(routed.judgeList[0].isGap, true);
  assert.match(judgeLlm.requestList[0].messageList.at(-1).content[0].text, /이 막대를 보시면/);
  assert.match(judgeLlm.requestList[0].messageList.at(-1).content[0].text, /1\) \[지시대명사\] "이 막대"/);
  assert.ok(judgeLlm.requestList[0].systemPrompt.length > 0);
});

test('통합 라우터: 판정할 수 없으면(백엔드 없음·판정 실패·후보 없음) 해설하지 않는다(최소 출력 원칙)', async () => {
  const unusedJudgeLlm = createFakeJudgeLlm({ text: '' });
  const noBackendRouter = createUnifiedRouter({ config: { ...gpuConfig, judgeBackend: 'bedrock', bedrockApiKey: '' }, judgeLlm: unusedJudgeLlm });
  const noBackend = await noBackendRouter.route({ utterance: '이것', candidateList: [triggerCandidate] });
  assert.equal(noBackend.source, ROUTER_SOURCE_MAP.fallback);
  assert.deepEqual(noBackend.candidateList, []);
  assert.equal(noBackend.blockedReason, 'judge_unavailable');
  const noCandidate = await noBackendRouter.route({ utterance: '이것', candidateList: [] });
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
