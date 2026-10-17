import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createGapInferenceAgent, GAP_SOURCE_MAP, GAP_REQUEST_BY_MODE_MAP,
} = require('../src/main/caption-pipeline/output/gap-inference-agent.js');
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');

const GPU_URL = 'http://gpu.test/v1/chat/completions';
const config = {
  ...readPipelineConfig({ AWS_BEARER_TOKEN_BEDROCK: 'key' }),
  judgeGpuUrl: GPU_URL, judgeGpuModel: 'qwen3.5-9b',
};

const gapList = [
  { offsetMs: 400, kind: 'pause', silenceMs: 300, beforeText: '여기 이 표를', afterText: '보시면' },
  { offsetMs: 1500, kind: 'complete', silenceMs: 700, beforeText: '보시면 됩니다', afterText: '먼저 1분기는' },
];
const request = { narrationText: '물류비 추이 표를 보는 중', narrationType: 'deixis', gapList };
const ANSWER = '{"gapIndex":1,"reason":"문장이 끝난 직후"}';

// 응답을 차례로 돌려준다. 한 응답은 { status, content, reasoning, finishReason }.
function createFakeFetch(responseList = [{ content: ANSWER }]) {
  const callList = [];
  const fetchImpl = async (url, init) => {
    callList.push({ url, body: JSON.parse(init.body) });
    const { status = 200, content = '', reasoning = '', finishReason = 'stop' } = responseList[callList.length - 1] || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: finishReason }] }),
    };
  };
  return { fetchImpl, callList };
}

test('품질 모드는 GPU 판정 LLM 에 사고(thinking)를 켜고 사고 한도에 답 몫을 더해 묻는다', async () => {
  const { fetchImpl, callList } = createFakeFetch();
  const agent = createGapInferenceAgent({ config, fetchImpl });
  const result = await agent.infer({ ...request, mode: 'listening' });

  assert.equal(callList.length, 1);
  assert.equal(callList[0].url, GPU_URL);
  assert.equal(callList[0].body.model, 'qwen3.5-9b');
  assert.equal(callList[0].body.chat_template_kwargs.enable_thinking, true);
  assert.equal(callList[0].body.max_tokens, GAP_REQUEST_BY_MODE_MAP.listening.thinkingBudget + 120);
  assert.equal(callList[0].body.messages[0].role, 'system');
  assert.equal(callList[0].body.messages.at(-1).role, 'user');
  assert.deepEqual(
    { gapIndex: result.gapIndex, source: result.source, modelId: result.modelId },
    { gapIndex: 1, source: GAP_SOURCE_MAP.gpu, modelId: 'qwen3.5-9b+thinking' },
  );
});

test('사고가 한도에서 끊기면 그때까지의 사고를 닫고 답만 한 번 더 받는다', async () => {
  const { fetchImpl, callList } = createFakeFetch([
    { content: '', reasoning: '후보 [0]은 중단, [1]은 완결이다', finishReason: 'length' },
    // 출력에 생각 끝 토큰이 없어 추론 파서가 답을 reasoning 칸에 담는다.
    { content: '', reasoning: `\n\n${ANSWER}` },
  ]);
  const agent = createGapInferenceAgent({ config, fetchImpl });
  const result = await agent.infer({ ...request, mode: 'listening' });

  assert.equal(callList.length, 2);
  const closing = callList[1].body;
  assert.equal(closing.continue_final_message, true);
  assert.equal(closing.add_generation_prompt, false);
  assert.equal(closing.max_tokens, 120);
  assert.deepEqual(closing.messages.slice(0, -1), callList[0].body.messages);
  const assistantText = closing.messages.at(-1).content;
  assert.equal(closing.messages.at(-1).role, 'assistant');
  assert.match(assistantText, /^<think>\n후보 \[0\]은 중단, \[1\]은 완결이다/);
  assert.match(assistantText, /<\/think>\n\n$/);
  assert.deepEqual({ gapIndex: result.gapIndex, source: result.source }, { gapIndex: 1, source: GAP_SOURCE_MAP.gpu });
});

test('균형 모드는 같은 GPU 판정 LLM 에 사고 없이 묻는다', async () => {
  const { fetchImpl, callList } = createFakeFetch();
  const agent = createGapInferenceAgent({ config, fetchImpl });
  const result = await agent.infer({ ...request, mode: 'delayed' });

  assert.equal(callList[0].body.chat_template_kwargs.enable_thinking, false);
  assert.equal(callList[0].body.max_tokens, 120);
  assert.equal(result.source, GAP_SOURCE_MAP.gpu);
  assert.equal(result.modelId, 'qwen3.5-9b');
});

test('사고는 품질 모드에만 켜고 시간도 그 모드 지연 안에서 넉넉히 준다', () => {
  const { listening, delayed } = GAP_REQUEST_BY_MODE_MAP;
  assert.equal(listening.isThinking, true);
  assert.equal(delayed.isThinking, false);
  assert.ok(listening.thinkingBudget > 0);
  assert.equal(delayed.thinkingBudget, 0);
  assert.ok(listening.timeoutMs > delayed.timeoutMs);
  // 품질 모드 지연(60초) 안에서 답해야 그 틈을 쓸 수 있다.
  assert.ok(listening.timeoutMs < 60000);
  // 균형 모드 지연(10초)보다 오래 기다리면 고른 틈을 재생이 이미 지난다.
  assert.ok(delayed.timeoutMs < 10000);
});

test('Bedrock 키가 없어도 GPU 로 삽입 위치를 고른다', async () => {
  const { fetchImpl, callList } = createFakeFetch();
  const agent = createGapInferenceAgent({ config: { ...config, bedrockApiKey: '' }, fetchImpl });
  const result = await agent.infer({ ...request, mode: 'delayed' });

  assert.equal(callList.length, 1);
  assert.equal(result.source, GAP_SOURCE_MAP.gpu);
});

test('GPU 가 실패하면 Bedrock 으로 넘기지 않고 규칙(첫 완결 경계)으로 고른다', async () => {
  const { fetchImpl, callList } = createFakeFetch([{ status: 500 }]);
  const agent = createGapInferenceAgent({ config, fetchImpl });
  const result = await agent.infer({ ...request, mode: 'listening' });

  assert.equal(callList.length, 1);
  assert.equal(callList[0].url, GPU_URL);
  assert.equal(result.source, GAP_SOURCE_MAP.fallback);
  assert.equal(result.gapIndex, 1);
});

test('사고도 답도 없이 끊기면 다시 묻지 않고 규칙으로 고른다', async () => {
  const { fetchImpl, callList } = createFakeFetch([{ content: '', finishReason: 'length' }]);
  const agent = createGapInferenceAgent({ config, fetchImpl });
  const result = await agent.infer({ ...request, mode: 'listening' });

  assert.equal(callList.length, 1);
  assert.equal(result.source, GAP_SOURCE_MAP.fallback);
  assert.equal(result.gapIndex, 1);
  assert.match(result.reason, /length/);
});

test('균형 모드는 답이 끊겨도 사고를 닫는 두 번째 요청을 보내지 않는다', async () => {
  const { fetchImpl, callList } = createFakeFetch([{ content: '', reasoning: '생각', finishReason: 'length' }]);
  const agent = createGapInferenceAgent({ config, fetchImpl });
  const result = await agent.infer({ ...request, mode: 'delayed' });

  assert.equal(callList.length, 1);
  assert.equal(result.source, GAP_SOURCE_MAP.fallback);
});

test('후보 틈이 없으면 GPU 를 부르지 않는다', async () => {
  const { fetchImpl, callList } = createFakeFetch();
  const agent = createGapInferenceAgent({ config, fetchImpl });
  const result = await agent.infer({ ...request, gapList: [], mode: 'listening' });

  assert.equal(callList.length, 0);
  assert.equal(result.source, GAP_SOURCE_MAP.none);
});

test('삽입 위치 추론용 Bedrock 모델 설정은 더 이상 없다', () => {
  const pipelineConfig = readPipelineConfig({ SEEON_BEDROCK_GAP_QUALITY_MODEL_ID: 'anthropic.claude-opus-4-7' });
  assert.equal(pipelineConfig.gapModelByModeMap, undefined);
});
