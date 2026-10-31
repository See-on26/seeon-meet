const { createJudgeLlm } = require('../agents/shared/judge-llm');
const {
  NARRATION_TYPE_MAP, DEIXIS_FORM_MAP, DEIXIS_REFERENCE_MAP,
  INTERPRETATION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP,
} = require('../contracts/narration-types');
const { TRIGGER_TYPE_MAP } = require('../trigger/speech-trigger');
const {
  ROUTER_BLOCKED_REASON_MAP, ROUTER_PROMPT_MAP, JUDGE_GROUP_MAP, JUDGE_GROUP_LABEL_MAP, GAP_VERDICT_MAP,
  readJudgeGroup, buildRouterInput, buildFewShotMessageList,
} = require('../prompts/unified-router');
const { verifyValueEvidence, needsEvidence } = require('./judge-evidence');

const REQUEST_TIMEOUT_MS = 15000;
// 단순 수치·변화 X 판단마다 근거 구절을 옮겨 적으므로 예전(400)보다 넉넉히 둔다.
const MAX_ROUTER_TOKENS = 500;

const ROUTER_SOURCE_MAP = { gpu: 'gpu', error: 'error', none: 'none' };

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
// context({ before, utterance, after })를 주면 단순 수치·변화 후보의 X 판단은 옮겨 적은 근거(evidence)가
// 확인될 때만 믿고, 확인되지 않으면 O 로 바꾼다. 판단 자체를 못 읽은 후보는 그대로 X 다.
function parseJudgeText({ text, candidateList, context = null }) {
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
            evidence: typeof entry.evidence === 'string' ? entry.evidence.trim() : '',
          });
        }
      }
    } catch {
      // 읽지 못한 판단은 모두 X 로 둔다.
    }
  }
  return candidateList.map((candidate) => {
    const verdict = verdictById.get(candidate.id);
    const judged = {
      ...candidate,
      isGap: Boolean(verdict?.isGap),
      reason: verdict?.reason || (verdict ? '' : '판단 없음'),
      evidence: verdict?.evidence || '',
    };
    if (!context || !verdict || judged.isGap || !needsEvidence({ type: candidate.type })) return judged;
    const { isVerified, failReason } = verifyValueEvidence({
      type: candidate.type, phrase: candidate.phrase, evidence: judged.evidence, context,
    });
    if (isVerified) return judged;
    return { ...judged, isGap: true, reason: `근거 확인 실패(${failReason}) → O · 원래 판단: ${judged.reason}` };
  });
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

// 해설 자리는 해설이 실제로 다루는 후보 구(고른 후보와 그 해설에 흡수된 지시 구·둘째 변화 구) 가운데 가장 늦게 말한 시각이다.
// 뒤 조각의 후보가 합쳐져 해설이 되었는데 결정의 첫 후보 시각에 넣으면 그 말을 하기 전에 해설이 나온다.
// 다루는 구의 시각을 모르면 결정의 원 사건 시각을 쓴다.
function resolveNarrationEventVideoTimeMs({ judgeList = [], selectedCandidate = null, fallbackMs = null }) {
  const coveredPhraseList = [
    selectedCandidate?.anchor, ...(selectedCandidate?.mergedAnchorList || []), ...(selectedCandidate?.mergedClaimList || []),
  ].filter(Boolean);
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
    // 묶음마다 자기 지시문으로 동시에 묻는다. 그 문장에 없는 묶음은 부르지 않는다.
    const groupList = Object.values(JUDGE_GROUP_MAP)
      .map((group) => ({ group, candidateList: numberedList.filter((candidate) => readJudgeGroup(candidate.type) === group) }))
      .filter(({ candidateList: groupCandidateList }) => groupCandidateList.length);
    const settledList = await Promise.allSettled(groupList.map(({ group, candidateList: groupCandidateList }) => judgeGroup({
      group, candidateList: groupCandidateList, before, utterance, after,
    })));
    const judgedById = new Map();
    let source = null;
    settledList.forEach((settled, index) => {
      const { group, candidateList: groupCandidateList } = groupList[index];
      if (settled.status === 'fulfilled') {
        source = source || settled.value.source;
        for (const entry of settled.value.judgeList) judgedById.set(entry.id, entry);
        return;
      }
      console.error(`[pipeline] ${JUDGE_GROUP_LABEL_MAP[group]} 판단 LLM 실패, 그 후보는 해설하지 않음:`, settled.reason?.message);
      for (const candidate of groupCandidateList) {
        judgedById.set(candidate.id, { ...candidate, isGap: false, reason: ROUTER_BLOCKED_REASON_MAP.judgeError, evidence: '' });
      }
    });
    if (!source) {
      return buildBlockedResult({
        candidateList: numberedList, blockedReason: ROUTER_BLOCKED_REASON_MAP.judgeError, source: ROUTER_SOURCE_MAP.error,
      });
    }
    const judgeList = numberedList.map((candidate) => judgedById.get(candidate.id));
    const narrationCandidateList = toNarrationCandidateList(judgeList);
    return {
      candidateList: narrationCandidateList, judgeList, source,
      blockedReason: narrationCandidateList.length ? null : ROUTER_BLOCKED_REASON_MAP.noGap,
    };
  }

  // 묶음 안에서는 후보 번호를 1부터 다시 매겨 묻고(예시와 같은 모양), 답을 원래 번호로 되돌린다.
  async function judgeGroup({ group, candidateList: groupCandidateList, before, utterance, after }) {
    const localList = groupCandidateList.map((candidate, index) => ({ ...candidate, id: index + 1 }));
    const { text, source } = await judgeLlm.requestText({
      systemPrompt: ROUTER_PROMPT_MAP[group].systemPrompt,
      messageList: [
        ...buildFewShotMessageList({ group }),
        { role: 'user', content: [{ text: buildRouterInput({ before, utterance, after, candidateList: localList }) }] },
      ],
      maxTokens: MAX_ROUTER_TOKENS, timeoutMs: REQUEST_TIMEOUT_MS, label: `${JUDGE_GROUP_LABEL_MAP[group]} 판단`,
    });
    const localJudgeList = parseJudgeText({ text, candidateList: localList, context: { before, utterance, after } });
    return {
      source, judgeList: localJudgeList.map((entry, index) => ({ ...entry, id: groupCandidateList[index].id })),
    };
  }

  return { route };
}

module.exports = {
  createUnifiedRouter, parseJudgeText, toNarrationCandidateList, buildRouterInput,
  ROUTER_PROMPT_MAP, ROUTER_BLOCKED_REASON_MAP, ROUTER_SOURCE_MAP, ROUTER_MODE_MAP,
  NARRATION_BY_TRIGGER_TYPE_MAP, resolveNarrationEventVideoTimeMs,
};
