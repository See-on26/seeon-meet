const { requestConverseText } = require('./bedrock-converse');

// 탐지 단계 경량 LLM 판정(통합 라우터·무발화 판정·지시 판정)을 어디로 보낼지. gpu 는 GPU 서버 LLM 만 쓰고
// 실패해도 Claude(Bedrock)로 넘기지 않는다. bedrock 을 고르거나 설정에 백엔드가 없으면(옛 호출) Bedrock 만 쓴다.
const JUDGE_BACKEND_MAP = { gpu: 'gpu', bedrock: 'bedrock' };
const JUDGE_SOURCE_MAP = { gpu: 'gpu', bedrock: 'bedrock' };

// 판정 답은 짧은 JSON 이라 GPU 는 보통 0.5~2초다. 이보다 오래 걸리면 판정을 포기한다(늦은 해설은 쓸모가 없다).
const GPU_JUDGE_TIMEOUT_MS = 6000;

function toMessageText({ content }) {
  if (typeof content === 'string') return content;
  return (content || []).map((part) => part?.text).filter((text) => typeof text === 'string').join('\n');
}

// Converse 형식(system 별도, content 는 text 블록 목록)을 OpenAI chat 형식으로 옮긴다. few-shot 순서는 그대로다.
function toChatMessageList({ systemPrompt, messageList }) {
  return [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...messageList.map((message) => ({ role: message.role, content: toMessageText(message) })),
  ];
}

function createJudgeLlm({
  config, fetchImpl = (...argList) => fetch(...argList), requestConverse = requestConverseText,
}) {
  const isGpuBackend = config.judgeBackend === JUDGE_BACKEND_MAP.gpu;

  async function requestGpu({ systemPrompt, messageList, maxTokens, timeoutMs, label }) {
    const response = await fetchImpl(config.judgeGpuUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.judgeGpuModel,
        temperature: 0,
        max_tokens: maxTokens,
        chat_template_kwargs: { enable_thinking: false },
        messages: toChatMessageList({ systemPrompt, messageList }),
      }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, GPU_JUDGE_TIMEOUT_MS)),
    });
    if (!response.ok) throw new Error(`GPU 판정(${label}) HTTP ${response.status}`);
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error(`GPU 판정(${label}) 빈 응답`);
    return { text: content, source: JUDGE_SOURCE_MAP.gpu };
  }

  async function requestBedrock({ systemPrompt, messageList, maxTokens, timeoutMs, label }) {
    const { text } = await requestConverse({
      config, modelId: config.judgeModelId, systemPrompt, messageList, maxTokens, timeoutMs, label,
    });
    return { text, source: JUDGE_SOURCE_MAP.bedrock };
  }

  function requestText(request) {
    return isGpuBackend ? requestGpu(request) : requestBedrock(request);
  }

  return { requestText };
}

// GPU 백엔드는 Bedrock 키 없이도 판정할 수 있다. 둘 다 없으면 호출 쪽이 판정 없이 통과·차단을 정한다.
function isJudgeAvailable({ config }) {
  return config.judgeBackend === JUDGE_BACKEND_MAP.gpu || Boolean(config.bedrockApiKey);
}

module.exports = {
  createJudgeLlm, toChatMessageList, isJudgeAvailable,
  JUDGE_BACKEND_MAP, JUDGE_SOURCE_MAP, GPU_JUDGE_TIMEOUT_MS,
};
