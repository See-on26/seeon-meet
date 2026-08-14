const { ensureUsPrefix, buildInferenceConfig } = require('./deixis-judge');
const { readConverseText } = require('../agents/shared/bedrock-converse');
const {
  NARRATION_TYPE_MAP, DEIXIS_FORM_MAP, DEIXIS_REFERENCE_MAP,
  INTERPRETATION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP,
} = require('../contracts/narration-types');
const {
  ROUTER_BLOCKED_REASON_MAP, ROUTER_SYSTEM_PROMPT, FEW_SHOT_LIST, buildRouterInput, buildFewShotMessageList,
} = require('../prompts/unified-router');

const REQUEST_TIMEOUT_MS = 15000;
const MAX_ROUTER_TOKENS = 300;

const ROUTER_SOURCE_MAP = { bedrock: 'bedrock', fallback: 'fallback', error: 'error' };

const ROUTER_MODE_MAP = {
  judge: 'judge',
  unified: 'unified',
  parallel: 'parallel',
};

const ALLOWED_SUB_KIND_MAP = {
  [NARRATION_TYPE_MAP.deixis]: Object.values(DEIXIS_FORM_MAP),
  [NARRATION_TYPE_MAP.interpretation]: Object.values(INTERPRETATION_KIND_MAP),
  [NARRATION_TYPE_MAP.visualDescription]: Object.values(VISUAL_DESCRIPTION_KIND_MAP),
};

function normalizeCandidate(rawCandidate) {
  if (!rawCandidate || typeof rawCandidate.type !== 'string') return null;
  const allowedSubKindList = ALLOWED_SUB_KIND_MAP[rawCandidate.type];
  if (!allowedSubKindList) return null;
  const isSubKindValid = allowedSubKindList.includes(rawCandidate.subKind);
  const isReferenceValid = Object.values(DEIXIS_REFERENCE_MAP).includes(rawCandidate.reference);
  return {
    type: rawCandidate.type,
    subKind: isSubKindValid ? rawCandidate.subKind : null,
    reference: isReferenceValid ? rawCandidate.reference : null,
    anchor: typeof rawCandidate.anchor === 'string' ? rawCandidate.anchor.trim() : '',
  };
}

function parseRouterText(text) {
  const fallback = {
    candidateList: [{
      type: NARRATION_TYPE_MAP.deixis, subKind: null, reference: null, anchor: '',
    }],
    blockedReason: null,
  };
  if (typeof text !== 'string') return fallback;
  const match = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  let parsed = null;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return fallback;
  }
  if (!Array.isArray(parsed.candidateList)) return fallback;
  const candidateList = parsed.candidateList
    .map((rawCandidate) => normalizeCandidate(rawCandidate))
    .filter(Boolean);

  if (!candidateList.length && typeof parsed.blockedReason !== 'string') return fallback;
  const blockedReason = candidateList.length ? null : parsed.blockedReason;
  return { candidateList, blockedReason };
}

function createUnifiedRouter({ config }) {
  const apiKey = config.bedrockApiKey;
  const converseUrl = `https://bedrock-runtime.${config.bedrockRegion}.amazonaws.com`
    + `/model/${ensureUsPrefix(config.judgeModelId)}/converse`;

  async function route({ utterance, before = '', after = '' }) {
    const passThrough = {
      candidateList: [{
        type: NARRATION_TYPE_MAP.deixis, subKind: null, reference: null, anchor: '',
      }],
      blockedReason: null,
    };
    if (!apiKey) return { ...passThrough, source: ROUTER_SOURCE_MAP.fallback };
    try {
      const response = await fetch(converseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: [{ text: ROUTER_SYSTEM_PROMPT }],
          messages: [
            ...buildFewShotMessageList(),
            { role: 'user', content: [{ text: buildRouterInput({ before, utterance, after }) }] },
          ],
          inferenceConfig: buildInferenceConfig({
            modelId: config.judgeModelId, maxTokens: MAX_ROUTER_TOKENS,
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
      return { ...parseRouterText(text), source: ROUTER_SOURCE_MAP.bedrock };
    } catch (error) {
      console.error('[pipeline] 라우터 실패, 통과 처리:', error.message);
      return { ...passThrough, source: ROUTER_SOURCE_MAP.error };
    }
  }

  return { route };
}

module.exports = {
  createUnifiedRouter, parseRouterText, buildRouterInput, normalizeCandidate,
  ROUTER_SYSTEM_PROMPT, ROUTER_BLOCKED_REASON_MAP, ROUTER_SOURCE_MAP, ROUTER_MODE_MAP,
};
