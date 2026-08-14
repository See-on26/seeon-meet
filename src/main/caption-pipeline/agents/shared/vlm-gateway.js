const REQUEST_TIMEOUT_MS = 20000;

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 200;

function toImageBlock({ jpegBuffer }) {
  return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}` } };
}

function buildVlmRequestBody({ jpegBuffer = null, jpegBufferList = null, vlmModel, prompt,
  temperature = DEFAULT_TEMPERATURE, maxTokens = DEFAULT_MAX_TOKENS, extraBodyMap = null }) {
  const bufferList = jpegBufferList?.length ? jpegBufferList : [jpegBuffer].filter(Boolean);
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

async function requestVlmContent({ config, jpegBuffer, jpegBufferList, prompt, label,
  temperature, maxTokens, timeoutMs = REQUEST_TIMEOUT_MS, extraBodyMap = null }) {
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

module.exports = { buildVlmRequestBody, requestVlmContent, REQUEST_TIMEOUT_MS };
