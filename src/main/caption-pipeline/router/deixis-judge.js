const {
  ensureUsPrefix, buildInferenceConfig, readConverseText,
} = require('../agents/shared/bedrock-converse');
const {
  JUDGE_REASON_MAP, JUDGE_SYSTEM_PROMPT, FEW_SHOT_LIST,
} = require('../prompts/deixis-judge');

const REQUEST_TIMEOUT_MS = 15000;
const MAX_JUDGE_TOKENS = 40;
const JUDGE_SOURCE_MAP = { bedrock: 'bedrock', fallback: 'fallback', error: 'error' };

function buildJudgeInput({ before = '', utterance, after = '' }) {
  return [
    `앞 맥락: ${before || '(없음)'}`,
    `지시 발화: "${utterance}"`,
    `뒤 맥락(look-ahead): ${after || '(없음)'}`,
    '판정(JSON 한 줄):',
  ].join('\n');
}

function buildFewShotMessageList() {
  return FEW_SHOT_LIST.flatMap((example) => [
    { role: 'user', content: [{ text: buildJudgeInput(example.input) }] },
    { role: 'assistant', content: [{ text: JSON.stringify(example.output) }] },
  ]);
}

function parseJudgeText(text) {
  if (typeof text !== 'string') return { shouldCaption: true, reason: null };
  const match = text.replace(/```(?:json)?/g, '').match(/\{[^{}]*\}/);
  if (!match) {
    return { shouldCaption: !/false/i.test(text), reason: null };
  }
  try {
    const parsed = JSON.parse(match[0]);
    return { shouldCaption: Boolean(parsed.caption), reason: typeof parsed.reason === 'string' ? parsed.reason : null };
  } catch {
    return { shouldCaption: true, reason: null };
  }
}

function createDeixisJudgeClient({ config }) {
  const apiKey = config.bedrockApiKey;
  const converseUrl = `https://bedrock-runtime.${config.bedrockRegion}.amazonaws.com`
    + `/model/${ensureUsPrefix(config.judgeModelId)}/converse`;

  async function judge({ utterance, before = '', after = '' }) {
    if (!apiKey) return { shouldCaption: true, reason: null, source: JUDGE_SOURCE_MAP.fallback };
    try {
      const response = await fetch(converseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: [{ text: JUDGE_SYSTEM_PROMPT }],
          messages: [
            ...buildFewShotMessageList(),
            { role: 'user', content: [{ text: buildJudgeInput({ before, utterance, after }) }] },
          ],
          inferenceConfig: buildInferenceConfig({
            modelId: config.judgeModelId, maxTokens: MAX_JUDGE_TOKENS,
          }),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 160);
        throw new Error(`Bedrock Converse HTTP ${response.status} ${body}`);
      }
      const json = await response.json();
      const text = readConverseText({ json });
      return { ...parseJudgeText(text), source: JUDGE_SOURCE_MAP.bedrock };
    } catch (error) {
      console.error('[pipeline] 지시 판정기 실패, 통과 처리:', error.message);
      return { shouldCaption: true, reason: null, source: JUDGE_SOURCE_MAP.error };
    }
  }

  return { judge };
}

module.exports = {
  createDeixisJudgeClient, parseJudgeText, buildJudgeInput, ensureUsPrefix,
  buildInferenceConfig, JUDGE_REASON_MAP,
};
