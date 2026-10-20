const REQUEST_TIMEOUT_MS = 20000;

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 200;

function toImageBlock({ jpegBuffer }) {
  return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}` } };
}

function toBufferList({ jpegBuffer, jpegBufferList }) {
  return jpegBufferList?.length ? jpegBufferList : [jpegBuffer].filter(Boolean);
}

function buildVlmRequestBody({ jpegBuffer = null, jpegBufferList = null, vlmModel, prompt,
  temperature = DEFAULT_TEMPERATURE, maxTokens = DEFAULT_MAX_TOKENS, extraBodyMap = null }) {
  const bufferList = toBufferList({ jpegBuffer, jpegBufferList });
  return {
    model: vlmModel,
    temperature,
    max_tokens: maxTokens,
    ...(extraBodyMap || {}),
    chat_template_kwargs: { enable_thinking: false },
    messages: [{
      role: 'user',
      content: [
        ...bufferList.map((buffer) => toImageBlock({ jpegBuffer: buffer })),
        { type: 'text', text: prompt },
      ],
    }],
  };
}

// 화면 이해는 GPU 서버 VLM 만 쓴다. 실패하면 Claude(Bedrock)로 넘기지 않고 오류를 그대로 던져 그 해설을 내지 않는다.
async function requestVlmContent({ config, jpegBuffer, jpegBufferList, prompt, label,
  temperature, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = REQUEST_TIMEOUT_MS, extraBodyMap = null }) {
  const response = await fetch(config.vlmUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildVlmRequestBody({
      jpegBuffer, jpegBufferList, vlmModel: config.vlmModel, prompt, temperature, maxTokens,
      extraBodyMap,
    })),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`VLM(${label}) HTTP ${response.status}`);
  const body = await response.json();
  const message = body?.choices?.[0]?.message;

  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  const reasoning = message?.reasoning;
  // 사고를 끄고 묻는데도 답이 reasoning 칸에만 오면 그 글을 답으로 쓴다. 모델에 따라 이 글이 생각일 수 있어 횟수를 보려고 남긴다.
  if (typeof reasoning === 'string' && reasoning.trim()) {
    console.warn(`[vlm] content 가 비어 reasoning 을 답으로 쓴다 (${label}, 모델 ${config.vlmModel}, ${reasoning.length}자)`);
  }
  return reasoning ?? content;
}

module.exports = { buildVlmRequestBody, requestVlmContent, REQUEST_TIMEOUT_MS };
