const TEMPERATURE_DEPRECATED_MODEL_LIST = [
  'anthropic.claude-sonnet-5',
  'anthropic.claude-opus-4-7',
];

const CONVERSE_TEMPERATURE = 0;

function ensureUsPrefix(modelId) {
  return modelId.startsWith('us.') ? modelId : `us.${modelId}`;
}

function buildInferenceConfig({ modelId, maxTokens }) {
  const bareModelId = modelId.startsWith('us.') ? modelId.slice('us.'.length) : modelId;
  const isTemperatureDeprecated = TEMPERATURE_DEPRECATED_MODEL_LIST
    .some((deprecatedModelId) => bareModelId.startsWith(deprecatedModelId));
  if (isTemperatureDeprecated) return { maxTokens };
  return { maxTokens, temperature: CONVERSE_TEMPERATURE };
}

function buildConverseUrl({ bedrockRegion, modelId, converseOrigin = '' }) {
  const origin = converseOrigin || `https://bedrock-runtime.${bedrockRegion}.amazonaws.com`;
  return `${origin}/model/${ensureUsPrefix(modelId)}/converse`;
}

async function requestConverseText({ config, modelId, systemPrompt = '', messageList,
  maxTokens, timeoutMs, label }) {
  if (!Number.isFinite(timeoutMs)) {
    throw new Error(`Bedrock(${label}): timeoutMs를 반드시 지정해야 합니다`);
  }
  if (!config.bedrockApiKey) {
    throw new Error(`Bedrock(${label}): API 키가 없습니다`);
  }
  const requestBody = {
    messages: messageList,
    inferenceConfig: buildInferenceConfig({ modelId, maxTokens }),
  };

  if (systemPrompt) requestBody.system = [{ text: systemPrompt }];

  const response = await fetch(buildConverseUrl({
    bedrockRegion: config.bedrockRegion, modelId, converseOrigin: config.converseOrigin,
  }), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.bedrockApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`Bedrock(${label}) HTTP ${response.status} ${body}`);
  }
  const json = await response.json();
  return {
    text: json?.output?.message?.content?.[0]?.text || '',
    stopReason: json?.stopReason || '',
    usage: json?.usage || null,
  };
}

module.exports = {
  requestConverseText, buildConverseUrl, ensureUsPrefix, buildInferenceConfig,
  TEMPERATURE_DEPRECATED_MODEL_LIST, CONVERSE_TEMPERATURE,
};
