import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createGapInferenceAgent, buildThinkingHandoffText, GAP_SOURCE_MAP, GAP_REQUEST_BY_MODE_MAP,
} = require('../src/main/caption-pipeline/output/gap-inference-agent.js');
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');

const GPU_URL = 'http://gpu.test/v1/chat/completions';
const config = {
  ...readPipelineConfig({ AWS_BEARER_TOKEN_BEDROCK: 'key' }),
  judgeGpuUrl: GPU_URL, judgeGpuModel: 'gemma-4-26b-a4b-qat',
};

const gapList = [
  { offsetMs: 400, kind: 'pause', silenceMs: 300, beforeText: '여기 이 표를', afterText: '보시면' },
  { offsetMs: 1500, kind: 'complete', silenceMs: 700, beforeText: '보시면 됩니다', afterText: '먼저 1분기는' },
];
const request = { narrationText: '물류비 추이 표를 보는 중', narrationType: 'deixis', gapList };
const ANSWER = '{"gapIndex":1,"reason":"문장이 끝난 직후"}';

// 응답을 차례로 돌려준다. 한 응답은 { status, content, reasoning, reasoningField, finishReason }.
// reasoningField 는 생각을 싣는 칸 이름이다(지금 Gemma 서버의 gemma4 파서는 reasoning, 옛 Qwen 서버는 reasoning_content).
function createFakeFetch(responseList = [{ content: ANSWER }]) {
  const callList = [];
  const fetchImpl = async (url, init) => {
    callList.push({ url, body: JSON.parse(init.body) });
    const {
      status = 200, content = '', reasoning = '', reasoningField = 'reasoning_content', finishReason = 'stop',
    } = responseList[callList.length - 1] || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ choices: [{ message: { content, [reasoningField]: reasoning }, finish_reason: finishReason }] }),
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
  assert.equal(callList[0].body.model, 'gemma-4-26b-a4b-qat');
  assert.equal(callList[0].body.chat_template_kwargs.enable_thinking, true);
  assert.equal(callList[0].body.max_tokens, GAP_REQUEST_BY_MODE_MAP.listening.thinkingBudget + 120);
  assert.equal(callList[0].body.messages[0].role, 'system');
  assert.equal(callList[0].body.messages.at(-1).role, 'user');
  assert.deepEqual(
    { gapIndex: result.gapIndex, source: result.source, modelId: result.modelId },
    { gapIndex: 1, source: GAP_SOURCE_MAP.gpu, modelId: 'gemma-4-26b-a4b-qat+thinking' },
  );
});

const CUT_REASONING = '후보 [0]은 중단, [1]은 완결이다';

test('끊긴 생각을 넘기는 글은 원래 입력, 빈 줄, 머리말, 따옴표로 감싼 생각, 답 요청 순서로 이어진다', () => {
  const userText = '해설: 물류비 추이 표를 보는 중\n후보 틈:\n[0] 여기 이 표를 | 보시면';
  const text = buildThinkingHandoffText({ userText, reasoning: `\n${CUT_REASONING}\n\n` });

  assert.ok(text.startsWith(`${userText}\n\n`), '원래 입력을 맨 앞에 그대로 두고 빈 줄로 띄운다');
  const [header, ...restList] = text.slice(userText.length + 2).split('\n');
  assert.match(header, /끊겼다/);
  assert.deepEqual(restList, ['"""', CUT_REASONING, '"""', '선택(JSON 한 줄):']);
});

test('사고가 한도에서 끊기면 그때까지의 생각을 user 메시지로 넘겨 사고 없이 한 번 더 묻는다', async () => {
  const { fetchImpl, callList } = createFakeFetch([
    { content: '', reasoning: CUT_REASONING, finishReason: 'length' },
    { content: ANSWER },
  ]);
  const agent = createGapInferenceAgent({ config, fetchImpl });
  const result = await agent.infer({ ...request, mode: 'listening' });

  assert.equal(callList.length, 2);
  const first = callList[0].body;
  const handoff = callList[1].body;
  assert.equal('continue_final_message' in handoff, false);
  assert.equal('add_generation_prompt' in handoff, false);
  assert.equal(handoff.chat_template_kwargs.enable_thinking, false);
  assert.equal(handoff.max_tokens, 120);
  assert.deepEqual(handoff.messages.slice(0, -1), first.messages.slice(0, -1));
  const lastMessage = handoff.messages.at(-1);
  assert.equal(lastMessage.role, 'user');
  assert.ok(lastMessage.content.includes(first.messages.at(-1).content), '원래 입력을 그대로 담는다');
  assert.ok(lastMessage.content.includes(CUT_REASONING), '끊긴 생각을 담는다');
  assert.deepEqual({ gapIndex: result.gapIndex, source: result.source }, { gapIndex: 1, source: GAP_SOURCE_MAP.gpu });
});

test('생각을 넘겨 다시 물었는데 답이 content 없이 reasoning 에만 오면 그 글을 쓰지 않고 규칙으로 고른다', async () => {
  const { fetchImpl } = createFakeFetch([
    { content: '', reasoning: CUT_REASONING, finishReason: 'length' },
    { content: '', reasoning: ANSWER },
  ]);
  const agent = createGapInferenceAgent({ config, fetchImpl });
  const result = await agent.infer({ ...request, mode: 'listening' });

  assert.equal(result.source, GAP_SOURCE_MAP.fallback);
});

test('끊긴 생각이 reasoning 칸(Gemma)에 와도 생각을 넘겨 다시 묻는다', async () => {
  const { fetchImpl, callList } = createFakeFetch([
    { content: '', reasoning: CUT_REASONING, reasoningField: 'reasoning', finishReason: 'length' },
    { content: ANSWER },
  ]);
  const agent = createGapInferenceAgent({ config, fetchImpl });
  const result = await agent.infer({ ...request, mode: 'listening' });

  assert.equal(callList.length, 2);
  assert.ok(callList[1].body.messages.at(-1).content.includes(CUT_REASONING));
  assert.equal(result.gapIndex, 1);
});

test('균형 모드는 같은 GPU 판정 LLM 에 사고 없이 묻는다', async () => {
  const { fetchImpl, callList } = createFakeFetch();
  const agent = createGapInferenceAgent({ config, fetchImpl });
  const result = await agent.infer({ ...request, mode: 'delayed' });

  assert.equal(callList[0].body.chat_template_kwargs.enable_thinking, false);
  assert.equal(callList[0].body.max_tokens, 120);
  assert.equal(result.source, GAP_SOURCE_MAP.gpu);
  assert.equal(result.modelId, 'gemma-4-26b-a4b-qat');
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

test('균형 모드는 GPU 를 한 번만 불러 삽입 위치를 고른다', async () => {
  const { fetchImpl, callList } = createFakeFetch();
  const agent = createGapInferenceAgent({ config, fetchImpl });
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
