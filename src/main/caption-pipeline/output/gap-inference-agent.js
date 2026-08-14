const { ensureUsPrefix, buildInferenceConfig } = require('../router/deixis-judge');
const { readConverseText } = require('../agents/shared/bedrock-converse');
const { NARRATION_TYPE_MAP } = require('../contracts/narration-types');
const {
  BOUNDARY_KIND_MAP, BOUNDARY_KIND_LABEL_MAP, GAP_SYSTEM_PROMPT, FEW_SHOT_LIST,
} = require('../prompts/gap-inference');

const REQUEST_TIMEOUT_MS = 12000;
const MAX_GAP_TOKENS = 120;

const GAP_SOURCE_MAP = {
  bedrock: 'bedrock',
  fallback: 'fallback',
  none: 'none',
};

function formatGapLine({ gap, index }) {
  const offsetSec = (gap.offsetMs / 1000).toFixed(1);
  const sign = gap.offsetMs >= 0 ? '+' : '';
  const kindLabel = BOUNDARY_KIND_LABEL_MAP[gap.kind] || gap.kind;
  return `[${index}] ${sign}${offsetSec}초 · 앞 발화 "${gap.beforeText || '(없음)'}"`
    + ` · 끝맺음=${kindLabel} · 무음 ${(gap.silenceMs / 1000).toFixed(1)}초`
    + ` · 뒤 발화 "${gap.afterText || '(없음)'}"`;
}

function buildGapInput({ narrationText, narrationType, subKind = null, rationale = '',
  screenSummary = '', beforeTranscript = '', gapList }) {
  return [
    `내레이션: "${narrationText}"`,
    `유형: ${narrationType}${subKind ? ` / 세부: ${subKind}` : ''}`,
    `만들어진 근거: ${rationale || '(없음)'}`,
    `화면: ${screenSummary || '(없음)'}`,
    ...(beforeTranscript ? [`직전 맥락: ${beforeTranscript}`] : []),
    '트리거 시각: 0.0초 (아래 후보의 기준점 — 음수는 트리거보다 앞선 틈이다)',
    '',
    '후보 틈:',
    ...gapList.map((gap, index) => formatGapLine({ gap, index })),
    '',
    '선택(JSON 한 줄):',
  ].join('\n');
}

function buildFewShotMessageList() {
  return FEW_SHOT_LIST.flatMap((example) => [
    { role: 'user', content: [{ text: buildGapInput(example.input) }] },
    { role: 'assistant', content: [{ text: JSON.stringify(example.output) }] },
  ]);
}

function canPickBeforeTrigger({ narrationType }) {
  return narrationType === NARRATION_TYPE_MAP.speakerIdentity;
}

function selectFallbackGapIndex({ gapList }) {
  if (!Array.isArray(gapList) || !gapList.length) return null;
  const forwardList = gapList
    .map((gap, index) => ({ gap, index }))
    .filter((entry) => entry.gap.offsetMs >= 0)
    .sort((left, right) => left.gap.offsetMs - right.gap.offsetMs);
  const complete = forwardList.find((entry) => entry.gap.kind === BOUNDARY_KIND_MAP.complete);
  if (complete) return complete.index;
  return forwardList.length ? forwardList[0].index : null;
}

function parseGapText({ text, gapCount }) {
  const empty = { gapIndex: null, reason: '' };
  if (typeof text !== 'string') return empty;
  const match = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
  if (!match) return empty;
  let parsed = null;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return empty;
  }
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
  if (!Number.isInteger(parsed.gapIndex)) return { gapIndex: null, reason };
  if (parsed.gapIndex < 0 || parsed.gapIndex >= gapCount) return { gapIndex: null, reason };
  return { gapIndex: parsed.gapIndex, reason };
}

function createGapInferenceAgent({ config }) {
  const apiKey = config.bedrockApiKey;

  // 삽입 위치 추론은 모드별로 모델을 나눈다(품질=Opus / 균형=Sonnet). 매핑에 없으면 judge 모델로 폴백.
  function resolveModelId({ mode }) {
    return (config.gapModelByModeMap && config.gapModelByModeMap[mode]) || config.judgeModelId;
  }

  async function infer({ mode = null, narrationText, narrationType, subKind = null, rationale = '',
    screenSummary = '', beforeTranscript = '', gapList = [] }) {
    if (!gapList.length) return { gapIndex: null, reason: '후보 틈 없음', source: GAP_SOURCE_MAP.none };
    const modelId = resolveModelId({ mode });
    const converseUrl = `https://bedrock-runtime.${config.bedrockRegion}.amazonaws.com`
      + `/model/${ensureUsPrefix(modelId)}/converse`;
    if (!apiKey) {
      return {
        gapIndex: selectFallbackGapIndex({ gapList }),
        reason: '규칙 폴백 — 트리거 이후 첫 완결 경계 (Bedrock 키 없음)',
        source: GAP_SOURCE_MAP.fallback,
      };
    }
    try {
      const response = await fetch(converseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: [{ text: GAP_SYSTEM_PROMPT }],
          messages: [
            ...buildFewShotMessageList(),
            {
              role: 'user',
              content: [{
                text: buildGapInput({
                  narrationText, narrationType, subKind, rationale, screenSummary,
                  beforeTranscript, gapList,
                }),
              }],
            },
          ],
          inferenceConfig: buildInferenceConfig({
            modelId, maxTokens: MAX_GAP_TOKENS,
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
      const parsed = parseGapText({ text, gapCount: gapList.length });

      const chosen = Number.isInteger(parsed.gapIndex) ? gapList[parsed.gapIndex] : null;
      if (chosen && chosen.offsetMs < 0 && !canPickBeforeTrigger({ narrationType })) {
        return {
          gapIndex: selectFallbackGapIndex({ gapList }),
          reason: `앞선 틈은 이 유형에 쓸 수 없어 규칙으로 대체 (모델 사유="${parsed.reason}")`,
          source: GAP_SOURCE_MAP.fallback,
        };
      }
      return { ...parsed, source: GAP_SOURCE_MAP.bedrock, modelId };
    } catch (error) {
      console.error('[pipeline] 삽입 위치 추론 실패, 규칙 폴백:', error.message);
      return {
        gapIndex: selectFallbackGapIndex({ gapList }),
        reason: `규칙 폴백 — 첫 완결 경계 (${error.message})`,
        source: GAP_SOURCE_MAP.fallback,
      };
    }
  }

  return { infer };
}

module.exports = {
  createGapInferenceAgent, buildGapInput, parseGapText, selectFallbackGapIndex, formatGapLine,
  canPickBeforeTrigger, GAP_SYSTEM_PROMPT, GAP_SOURCE_MAP, BOUNDARY_KIND_MAP,
};
