const { createJudgeLlm, isJudgeAvailable } = require('../agents/shared/judge-llm');
const {
  NARRATION_TYPE_MAP, DEIXIS_FORM_MAP, DEIXIS_REFERENCE_MAP,
  INTERPRETATION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP,
} = require('../contracts/narration-types');
const { TRIGGER_TYPE_MAP } = require('../trigger/speech-trigger');
const {
  ROUTER_BLOCKED_REASON_MAP, ROUTER_SYSTEM_PROMPT, FEW_SHOT_LIST, GAP_VERDICT_MAP,
  buildRouterInput, buildFewShotMessageList,
} = require('../prompts/unified-router');

const REQUEST_TIMEOUT_MS = 15000;
const MAX_ROUTER_TOKENS = 400;

const ROUTER_SOURCE_MAP = { gpu: 'gpu', bedrock: 'bedrock', fallback: 'fallback', error: 'error', none: 'none' };

const ROUTER_MODE_MAP = {
  judge: 'judge',
  unified: 'unified',
  parallel: 'parallel',
};

// 트리거 유형 → 정보 공백을 채울 에이전트(해설 유형). 지시대명사·형용사+지시 명사는 지시 대상 설명,
// 단순 수치·변화·비교·결론·추상적 척도는 발화 기반 설명이다.
const NARRATION_BY_TRIGGER_TYPE_MAP = {
  [TRIGGER_TYPE_MAP.demonstrative]: { type: NARRATION_TYPE_MAP.deixis, reference: DEIXIS_REFERENCE_MAP.explicit },
  [TRIGGER_TYPE_MAP.adjectiveNoun]: { type: NARRATION_TYPE_MAP.deixis, reference: DEIXIS_REFERENCE_MAP.inclusive },
  [TRIGGER_TYPE_MAP.number]: { type: NARRATION_TYPE_MAP.interpretation, subKind: INTERPRETATION_KIND_MAP.valueToMeaning },
  [TRIGGER_TYPE_MAP.change]: { type: NARRATION_TYPE_MAP.interpretation, subKind: INTERPRETATION_KIND_MAP.claimToValue },
  [TRIGGER_TYPE_MAP.scale]: { type: NARRATION_TYPE_MAP.visualDescription, subKind: VISUAL_DESCRIPTION_KIND_MAP.scale },
};

function numberCandidateList(candidateList) {
  return candidateList
    .filter((candidate) => NARRATION_BY_TRIGGER_TYPE_MAP[candidate.type] && candidate.phrase)
    .map((candidate, index) => ({ ...candidate, id: index + 1 }));
}

// 판단 JSON 을 후보마다 읽는다. 판단이 없거나 "O"가 아니면 X 로 본다(애매하면 내보내지 않는다).
function parseJudgeText({ text, candidateList }) {
  const verdictById = new Map();
  if (typeof text === 'string') {
    const match = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
    try {
      const parsed = match ? JSON.parse(match[0]) : null;
      for (const entry of Array.isArray(parsed?.judgeList) ? parsed.judgeList : []) {
        const id = Number(entry?.id);
        if (Number.isInteger(id)) {
          verdictById.set(id, {
            isGap: String(entry.gap).trim().toUpperCase() === GAP_VERDICT_MAP.gap,
            reason: typeof entry.reason === 'string' ? entry.reason.trim() : '',
          });
        }
      }
    } catch {
      // 읽지 못한 판단은 모두 X 로 둔다.
    }
  }
  return candidateList.map((candidate) => ({
    ...candidate,
    isGap: Boolean(verdictById.get(candidate.id)?.isGap),
    reason: verdictById.get(candidate.id)?.reason || (verdictById.has(candidate.id) ? '' : '판단 없음'),
  }));
}

// 공백(O)인 후보를 해설 후보로 바꾼다. 지시 공백이 둘 이상이면 여러 대상을 함께 말한 것이라 완전형으로 묘사한다.
function toNarrationCandidateList(judgeList) {
  const gapList = judgeList.filter((entry) => entry.isGap);
  const deixisCount = gapList.filter((entry) => NARRATION_BY_TRIGGER_TYPE_MAP[entry.type].type === NARRATION_TYPE_MAP.deixis).length;
  return gapList.map((entry) => {
    const narration = NARRATION_BY_TRIGGER_TYPE_MAP[entry.type];
    const isDeixis = narration.type === NARRATION_TYPE_MAP.deixis;
    return {
      type: narration.type,
      subKind: isDeixis ? (deixisCount > 1 ? DEIXIS_FORM_MAP.complete : DEIXIS_FORM_MAP.simple) : narration.subKind,
      reference: narration.reference || null,
      anchor: entry.phrase,
      triggerType: entry.type,
    };
  });
}

// 해설 자리는 해설이 실제로 다루는 후보 구(고른 후보와 그 해설에 흡수된 지시 구) 가운데 가장 늦게 말한 시각이다.
// 뒤 조각의 후보가 합쳐져 해설이 되었는데 결정의 첫 후보 시각에 넣으면 그 말을 하기 전에 해설이 나온다.
// 다루는 구의 시각을 모르면 결정의 원 사건 시각을 쓴다.
function resolveNarrationEventVideoTimeMs({ judgeList = [], selectedCandidate = null, fallbackMs = null }) {
  const coveredPhraseList = [selectedCandidate?.anchor, ...(selectedCandidate?.mergedAnchorList || [])].filter(Boolean);
  const timeList = judgeList
    .filter((entry) => entry.isGap && coveredPhraseList.includes(entry.phrase) && Number.isFinite(entry.eventVideoTimeMs))
    .map((entry) => entry.eventVideoTimeMs);
  return timeList.length ? Math.max(...timeList) : fallbackMs;
}

function buildBlockedResult({ candidateList, blockedReason, source }) {
  return {
    candidateList: [], blockedReason, source,
    judgeList: candidateList.map((candidate) => ({ ...candidate, isGap: false, reason: blockedReason })),
  };
}

function createUnifiedRouter({ config, judgeLlm = createJudgeLlm({ config }) }) {
  // candidateList: 트리거가 뽑은 후보 구 [{ type, phrase, start, end }]. 후보마다 O/X 를 판단한다.
  async function route({ utterance, before = '', after = '', candidateList = [] }) {
    const numberedList = numberCandidateList(candidateList);
    if (!numberedList.length) {
      return buildBlockedResult({ candidateList: [], blockedReason: ROUTER_BLOCKED_REASON_MAP.noCandidate, source: ROUTER_SOURCE_MAP.none });
    }
    // 판단할 수 없으면 해설을 만들지 않는다(최소 출력 원칙).
    if (!isJudgeAvailable({ config })) {
      return buildBlockedResult({
        candidateList: numberedList, blockedReason: ROUTER_BLOCKED_REASON_MAP.judgeUnavailable, source: ROUTER_SOURCE_MAP.fallback,
      });
    }
    try {
      const { text, source } = await judgeLlm.requestText({
        systemPrompt: ROUTER_SYSTEM_PROMPT,
        messageList: [
          ...buildFewShotMessageList(),
          { role: 'user', content: [{ text: buildRouterInput({ before, utterance, after, candidateList: numberedList }) }] },
        ],
        maxTokens: MAX_ROUTER_TOKENS, timeoutMs: REQUEST_TIMEOUT_MS, label: '통합 라우터',
      });
      const judgeList = parseJudgeText({ text, candidateList: numberedList });
      const narrationCandidateList = toNarrationCandidateList(judgeList);
      return {
        candidateList: narrationCandidateList, judgeList, source,
        blockedReason: narrationCandidateList.length ? null : ROUTER_BLOCKED_REASON_MAP.noGap,
      };
    } catch (error) {
      console.error('[pipeline] 판단 LLM 실패, 해설하지 않음:', error.message);
      return buildBlockedResult({
        candidateList: numberedList, blockedReason: ROUTER_BLOCKED_REASON_MAP.judgeError, source: ROUTER_SOURCE_MAP.error,
      });
    }
  }

  return { route };
}

module.exports = {
  createUnifiedRouter, parseJudgeText, toNarrationCandidateList, buildRouterInput,
  ROUTER_SYSTEM_PROMPT, FEW_SHOT_LIST, ROUTER_BLOCKED_REASON_MAP, ROUTER_SOURCE_MAP, ROUTER_MODE_MAP,
  NARRATION_BY_TRIGGER_TYPE_MAP, resolveNarrationEventVideoTimeMs,
};
