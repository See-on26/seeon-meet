const { requestConverseText } = require('./bedrock-converse');

const REQUEST_TIMEOUT_MS = 20000;

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 200;

// GPU 가 한 번 실패하면 이 시간 동안 GPU 를 건너뛴다. 호출마다 타임아웃을 기다리지 않기 위해서다.
const GPU_BYPASS_MS = 60000;

let gpuBypassUntil = 0;
let fallbackListener = null;

function toImageBlock({ jpegBuffer }) {
  return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}` } };
}

function toConverseImageBlock({ jpegBuffer }) {
  return { image: { format: 'jpeg', source: { bytes: jpegBuffer.toString('base64') } } };
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

async function requestGpuVlmContent({ config, jpegBuffer, jpegBufferList, prompt, label,
  temperature, maxTokens, timeoutMs, extraBodyMap }) {
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
  return message?.reasoning ?? content;
}

// GPU VLM 과 같은 프롬프트·이미지를 Bedrock 으로 보낸다. vLLM 전용 옵션(extraBodyMap)은 버린다.
async function requestFallbackContent({ config, jpegBuffer, jpegBufferList, prompt, label,
  maxTokens, timeoutMs }) {
  const bufferList = toBufferList({ jpegBuffer, jpegBufferList });
  const { text } = await requestConverseText({
    config,
    modelId: config.vlmFallbackModelId,
    messageList: [{
      role: 'user',
      content: [
        ...bufferList.map((buffer) => toConverseImageBlock({ jpegBuffer: buffer })),
        { text: prompt },
      ],
    }],
    maxTokens,
    timeoutMs,
    label: `${label}·폴백`,
  });
  return text;
}

async function runFallback({ request, label, reason, isBypass, now, gpuError = null }) {
  const startedAt = now();
  try {
    const text = await requestFallbackContent(request);
    fallbackListener?.({ label, reason, isBypass, elapsedMs: now() - startedAt });
    return text;
  } catch (fallbackError) {
    const gpuReason = gpuError ? `${gpuError.message}; ` : '';
    throw new Error(`${gpuReason}${fallbackError.message}`);
  }
}

async function requestVlmContent({ config, jpegBuffer, jpegBufferList, prompt, label,
  temperature, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = REQUEST_TIMEOUT_MS,
  extraBodyMap = null, now = Date.now }) {
  const request = {
    config, jpegBuffer, jpegBufferList, prompt, label, temperature, maxTokens, timeoutMs, extraBodyMap,
  };
  const canFallback = Boolean(config.isVlmFallbackEnabled && config.bedrockApiKey);
  if (canFallback && now() < gpuBypassUntil) {
    return runFallback({ request, label, reason: 'GPU 우회 중', isBypass: true, now });
  }
  try {
    return await requestGpuVlmContent(request);
  } catch (gpuError) {
    if (!canFallback) throw gpuError;
    gpuBypassUntil = now() + GPU_BYPASS_MS;
    return runFallback({ request, label, reason: gpuError.message, isBypass: false, now, gpuError });
  }
}

function setVlmFallbackListener(listener) {
  fallbackListener = typeof listener === 'function' ? listener : null;
}

function resetVlmCircuit() {
  gpuBypassUntil = 0;
}

module.exports = {
  buildVlmRequestBody, requestVlmContent, setVlmFallbackListener, resetVlmCircuit,
  REQUEST_TIMEOUT_MS, GPU_BYPASS_MS,
};
