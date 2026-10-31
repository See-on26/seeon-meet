const { defaultVlmTraffic } = require('./vlm-traffic');

const REQUEST_TIMEOUT_MS = 20000;

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 200;

// foreground 는 실시간 해설·질문 답처럼 바로 보내는 요청, background 는 요약처럼 해설이 없을 때 보내는 요청이다.
const VLM_PRIORITY_MAP = { foreground: 'foreground', background: 'background' };

function toImageBlock({ jpegBuffer }) {
  return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}` } };
}

function toBufferList({ jpegBuffer, jpegBufferList }) {
  return jpegBufferList?.length ? jpegBufferList : [jpegBuffer].filter(Boolean);
}

// maxSoftTokens 는 그림 한 장의 이미지 토큰 수 상한이다. 값이 없거나 그림이 없는 글 요청이면 칸을 넣지 않아 서버에 띄운 값을 쓴다.
function buildVlmRequestBody({ jpegBuffer = null, jpegBufferList = null, vlmModel, prompt,
  temperature = DEFAULT_TEMPERATURE, maxTokens = DEFAULT_MAX_TOKENS, extraBodyMap = null, maxSoftTokens = null }) {
  const bufferList = toBufferList({ jpegBuffer, jpegBufferList });
  const hasMaxSoftTokens = Boolean(maxSoftTokens) && bufferList.length > 0;
  return {
    model: vlmModel,
    temperature,
    max_tokens: maxTokens,
    ...(extraBodyMap || {}),
    chat_template_kwargs: { enable_thinking: false },
    ...(hasMaxSoftTokens ? { mm_processor_kwargs: { max_soft_tokens: maxSoftTokens } } : {}),
    messages: [{
      role: 'user',
      content: [
        ...bufferList.map((buffer) => toImageBlock({ jpegBuffer: buffer })),
        { type: 'text', text: prompt },
      ],
    }],
  };
}

function pickAnswerText({ message, label, vlmModel }) {
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  const reasoning = message?.reasoning;
  // 사고를 끄고 묻는데도 답이 reasoning 칸에만 오면 그 글을 답으로 쓴다. 모델에 따라 이 글이 생각일 수 있어 횟수를 보려고 남긴다.
  if (typeof reasoning === 'string' && reasoning.trim()) {
    console.warn(`[vlm] content 가 비어 reasoning 을 답으로 쓴다 (${label}, 모델 ${vlmModel}, ${reasoning.length}자)`);
  }
  return reasoning ?? content;
}

// 화면 이해는 GPU 서버 VLM 만 쓴다. 실패하면 다른 서비스로 넘기지 않고 오류를 그대로 던져 그 해설을 내지 않는다.
// 배경 순위 요청은 실시간 해설 요청이 없을 때까지 기다린 뒤 보내고, 시간 제한은 보낼 때부터 잰다.
// finishReason 은 답이 maxTokens 에서 잘렸는지('length') 알려 준다.
async function requestVlmCompletion({ config, jpegBuffer, jpegBufferList, prompt, label,
  temperature, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = REQUEST_TIMEOUT_MS, extraBodyMap = null,
  priority = VLM_PRIORITY_MAP.foreground, traffic = defaultVlmTraffic, fetchImpl = fetch }) {
  const sendRequest = async () => {
    const response = await fetchImpl(config.vlmUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildVlmRequestBody({
        jpegBuffer, jpegBufferList, vlmModel: config.vlmModel, prompt, temperature, maxTokens,
        extraBodyMap, maxSoftTokens: config.vlmMaxSoftTokens,
      })),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`VLM(${label}) HTTP ${response.status}`);
    const body = await response.json();
    const choice = body?.choices?.[0];
    return {
      content: pickAnswerText({ message: choice?.message, label, vlmModel: config.vlmModel }),
      finishReason: choice?.finish_reason ?? null,
    };
  };
  return priority === VLM_PRIORITY_MAP.background ? traffic.runBackground(sendRequest) : traffic.runForeground(sendRequest);
}

// 실시간 해설·질문 답 경로: 전경으로 바로 보내고 답 글만 돌려준다.
async function requestVlmContent({ config, jpegBuffer, jpegBufferList, prompt, label,
  temperature, maxTokens, timeoutMs, extraBodyMap }) {
  const { content } = await requestVlmCompletion({
    config, jpegBuffer, jpegBufferList, prompt, label, temperature, maxTokens, timeoutMs, extraBodyMap,
    priority: VLM_PRIORITY_MAP.foreground,
  });
  return content;
}

module.exports = { buildVlmRequestBody, requestVlmCompletion, requestVlmContent, REQUEST_TIMEOUT_MS, VLM_PRIORITY_MAP };
