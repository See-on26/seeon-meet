import { buildUtteranceList, findPieceIndexByOffset } from './utterance-builder.mjs';
import { buildRouterInput, buildSilenceInput } from './router-context.mjs';
import { extractItemPositionList } from './extract-items.mjs';
import { extractProductionCandidateList } from './production-trigger.mjs';
import { isSpanOverlap } from './candidate-merge.mjs';
import { resolveCandidateVerdict } from './judge-runner.mjs';
import { mapWithConcurrency } from './concurrency.mjs';
import { TARGET_TYPE_MAP, CANDIDATE_SOURCE_MAP, TRIGGER_TYPE_BY_TARGET_TYPE_MAP } from './eval-types.mjs';

export const SYSTEM_MISS_REASON_MAP = {
  triggerMiss: 'trigger_miss',
  judgeBlock: 'judge_block',
  scaleDisabled: 'scale_disabled',
};

// 라우터 호출이 맡는 지표. production 트리거 후보만 넘긴 호출은 시스템 성능, 말주머니에만 있는 라벨 위치까지 넘긴 호출은
// 판정기 성능을 낸다. 말주머니에만 있는 라벨 위치가 없는 발화는 한 호출이 둘 다 맡는다.
export const ROUTER_CALL_ROLE_MAP = { system: 'system', judge: 'judge', both: 'system_judge' };

// 판정 뒤 단계는 생성·전달 단계의 걸러냄이라 평가에서 우회한다. 보고서에 그대로 적는다.
export const BYPASSED_STAGE_LIST = [
  '무발화 게이트(슬라이드당·분당 1회)',
  '간격·중복 억제',
  'VLM 의 NONE(특정 불가·이미 설명함)',
  '값 존재 검사',
  '한 발화 후보 1건 선택(중재) — 보조 칸 isArbiterSelected 로만 남긴다',
];

const toUtteranceKey = ({ itemId, utteranceIndex }) => `${itemId}#${utteranceIndex}`;

// 라벨 위치를 지금 production 트리거·말주머니로 다시 뽑은 후보와 겹침으로 대조한다.
// production 을 받아온 뒤 트리거가 바뀌었으면 출처(sourceList)와 트리거 포함 여부도 지금 기준이 된다.
// 발화마다 production 트리거 후보를 남겨 두었다가 판단 LLM 에 production 과 같은 후보 목록으로 넘긴다.
export function buildScorePlan({ itemList, matcher, productionTrigger }) {
  const positionList = [];
  const newCandidateList = [];
  const utteranceListMap = new Map();
  const productionCandidateListMap = new Map();
  let nullCount = 0;
  for (const item of itemList) {
    const utteranceList = buildUtteranceList({ item });
    utteranceListMap.set(item.id, utteranceList);
    const productionCandidateList = extractProductionCandidateList({ item, productionTrigger, utteranceList });
    for (const candidate of productionCandidateList) {
      const key = toUtteranceKey({ itemId: item.id, utteranceIndex: candidate.utteranceIndex });
      if (!productionCandidateListMap.has(key)) productionCandidateListMap.set(key, []);
      productionCandidateListMap.get(key).push(candidate);
    }
    const currentList = extractItemPositionList({ item, matcher, productionCandidateList });
    for (const labeled of item.positionList) {
      if (labeled.isGap === null) {
        nullCount += 1;
        continue;
      }
      const current = currentList.find((candidate) => candidate.type === labeled.type && isSpanOverlap(candidate, labeled));
      const sourceList = current ? current.sourceList : [];
      const utteranceIndex = findPieceIndexByOffset({ utteranceList, offset: labeled.start });
      // 판정 발화 안에서 같은 유형 production 트리거 후보와 겹쳐야 production 이 그 위치를 판단 LLM 에 넘긴다.
      const isProductionTriggered = labeled.type === TARGET_TYPE_MAP.silence
        ? sourceList.includes(CANDIDATE_SOURCE_MAP.production)
        : productionCandidateList.some((candidate) => candidate.utteranceIndex === utteranceIndex
          && candidate.type === labeled.type && isSpanOverlap(candidate, labeled));
      positionList.push({
        itemId: item.id,
        language: item.language,
        posId: labeled.posId,
        type: labeled.type,
        start: labeled.start,
        end: labeled.end,
        trigger: labeled.trigger,
        truthIsGap: labeled.isGap,
        truthRationale: labeled.rationale || '',
        sourceList,
        isProductionTriggered,
        utteranceIndex,
      });
    }
    for (const current of currentList) {
      const isLabeled = item.positionList.some((labeled) => labeled.type === current.type && isSpanOverlap(labeled, current));
      if (!isLabeled) newCandidateList.push({ itemId: item.id, ...current });
    }
  }
  return {
    positionList,
    utteranceListMap,
    productionCandidateListMap,
    newCandidateList,
    progress: { scoredCount: positionList.length, nullCount, newCandidateCount: newCandidateList.length },
  };
}

// production 트리거 후보를 라우터 입력 꼴({ type, phrase, start, end }, 위치는 발화 글 기준)로 옮긴다.
const toRouterCandidate = (candidate) => ({
  type: candidate.triggerType, phrase: candidate.phrase, start: candidate.pieceStart, end: candidate.pieceEnd,
});

// 말주머니에만 있는 라벨 위치를 판단 후보로 만든다. 유형은 production 트리거 유형 이름으로 바꾼다.
const toExtraRouterCandidate = ({ position, piece }) => ({
  type: TRIGGER_TYPE_BY_TARGET_TYPE_MAP[position.type], phrase: position.trigger,
  start: position.start - piece.start, end: position.end - piece.start,
});

// 발화마다 라우터를 부를 호출을 정한다. production 트리거 후보가 있으면 그 목록 그대로 1회(시스템),
// 말주머니에만 있는 라벨 위치가 있으면 그것을 더한 목록으로 1회 더(판정기) 부른다.
function planRouterCallList({ plan, contextWindow }) {
  const groupMap = new Map();
  for (const position of plan.positionList) {
    if (position.type === TARGET_TYPE_MAP.silence) continue;
    const key = toUtteranceKey(position);
    if (!groupMap.has(key)) groupMap.set(key, { itemId: position.itemId, utteranceIndex: position.utteranceIndex, extraList: [] });
    if (!position.isProductionTriggered) groupMap.get(key).extraList.push(position);
  }
  const callList = [];
  for (const [key, group] of groupMap) {
    const utteranceList = plan.utteranceListMap.get(group.itemId);
    const piece = utteranceList[group.utteranceIndex];
    const baseInput = buildRouterInput({ utteranceList, index: group.utteranceIndex, contextWindow });
    const systemCandidateList = (plan.productionCandidateListMap.get(key) || []).map(toRouterCandidate);
    const extraCandidateList = group.extraList.map((position) => toExtraRouterCandidate({ position, piece }));
    const base = { kind: 'router', itemId: group.itemId, utteranceIndex: group.utteranceIndex, pieceStart: piece.start };
    if (systemCandidateList.length) {
      group.systemCall = {
        ...base, key: `router:system:${key}`, role: extraCandidateList.length ? ROUTER_CALL_ROLE_MAP.system : ROUTER_CALL_ROLE_MAP.both,
        input: { ...baseInput, candidateList: systemCandidateList },
      };
      callList.push(group.systemCall);
    }
    group.judgeCall = group.systemCall;
    if (extraCandidateList.length) {
      group.judgeCall = {
        ...base, key: `router:judge:${key}`, role: ROUTER_CALL_ROLE_MAP.judge,
        input: {
          ...baseInput,
          candidateList: [...systemCandidateList, ...extraCandidateList].sort((left, right) => left.start - right.start || left.end - right.end),
        },
      };
      callList.push(group.judgeCall);
    }
  }
  return { callList, groupMap };
}

function buildSilenceRow({ position, call }) {
  const isPrecondition = call.output.skipReason === null || call.output.skipReason === undefined;
  const isJudgePass = isPrecondition && call.output.judged?.hasCue === true;
  const judgeReason = isPrecondition ? (call.output.judged?.reason || null) : `precondition:${call.output.skipReason}`;
  const isSystemPass = position.isProductionTriggered && isJudgePass;
  return {
    pathError: call.output.pathError,
    systemPathError: call.output.pathError,
    stopReason: call.output.capture?.stopReason ?? null,
    isJudgePass,
    judgeReason,
    judgeRationale: '',
    isSystemPass,
    systemJudgeReason: judgeReason,
    systemMissReason: isSystemPass ? null : resolveSystemMissReason({
      isProductionTriggered: position.isProductionTriggered, isJudgePass, isGeneratable: isJudgePass,
    }),
    isArbiterSelected: null,
    context: { transcript: call.input.transcript },
  };
}

function resolveSystemMissReason({ isProductionTriggered, isJudgePass, isGeneratable }) {
  if (!isProductionTriggered) return SYSTEM_MISS_REASON_MAP.triggerMiss;
  if (!isJudgePass) return SYSTEM_MISS_REASON_MAP.judgeBlock;
  if (!isGeneratable) return SYSTEM_MISS_REASON_MAP.scaleDisabled;
  return null;
}

// 판정기 성능은 판정 호출, 시스템 성능은 production 트리거 후보만 넘긴 호출의 O/X 로 정한다.
// production 트리거가 잡지 않은 위치는 production 이 판단 LLM 을 부르지 않으므로 시스템 성능에서 놓침이다.
function buildLexicalRow({ position, group, isScaleEnabled }) {
  const { judgeCall, systemCall } = group;
  const readVerdict = (call) => (call.output.pathError ? null : resolveCandidateVerdict({
    position, pieceStart: call.pieceStart, routed: call.output.routed, isScaleEnabled,
  }));
  const judgeVerdict = readVerdict(judgeCall);
  const ownSystemCall = position.isProductionTriggered ? systemCall : null;
  const systemVerdict = !ownSystemCall ? null : (ownSystemCall === judgeCall ? judgeVerdict : readVerdict(ownSystemCall));
  const isSystemPass = Boolean(systemVerdict?.isJudgePass && systemVerdict.isGeneratable);
  const pathErrorCall = judgeCall.output.pathError ? judgeCall : ownSystemCall;
  return {
    pathError: judgeCall.output.pathError,
    systemPathError: ownSystemCall ? ownSystemCall.output.pathError : null,
    stopReason: pathErrorCall?.output.capture?.stopReason ?? null,
    isJudgePass: judgeVerdict ? judgeVerdict.isJudgePass : null,
    judgeReason: judgeVerdict ? judgeVerdict.blockReason : null,
    judgeRationale: judgeVerdict ? judgeVerdict.rationale : '',
    isSystemPass,
    systemJudgeReason: systemVerdict ? systemVerdict.blockReason : null,
    systemMissReason: isSystemPass ? null : resolveSystemMissReason({
      isProductionTriggered: position.isProductionTriggered,
      isJudgePass: Boolean(systemVerdict?.isJudgePass),
      isGeneratable: Boolean(systemVerdict?.isGeneratable),
    }),
    isArbiterSelected: systemVerdict ? systemVerdict.isArbiterSelected : null,
    context: {
      utterance: judgeCall.input.utterance, before: judgeCall.input.before, after: judgeCall.input.after,
      candidateText: judgeVerdict?.judgeText ?? null,
      ...(ownSystemCall && ownSystemCall !== judgeCall ? { systemCandidateText: systemVerdict?.judgeText ?? null } : {}),
    },
  };
}

// 발화마다 라우터 1~2회(같은 발화의 후보는 호출을 나눠 쓴다), 무발화 위치마다 판정기 1회를 부른다.
export async function evaluateScorePlan({ plan, mode, contextWindow, repeatIndex, runner, concurrency, isScaleEnabled }) {
  const { callList: routerCallList, groupMap } = planRouterCallList({ plan, contextWindow });
  const silenceCallMap = new Map();
  for (const position of plan.positionList) {
    if (position.type !== TARGET_TYPE_MAP.silence) continue;
    const key = `silence:${toUtteranceKey(position)}`;
    if (silenceCallMap.has(key)) continue;
    silenceCallMap.set(key, {
      key, kind: 'silence', itemId: position.itemId, utteranceIndex: position.utteranceIndex,
      input: buildSilenceInput({ utteranceList: plan.utteranceListMap.get(position.itemId), index: position.utteranceIndex, mode }),
    });
  }
  const callList = [...routerCallList, ...silenceCallMap.values()];
  await mapWithConcurrency({
    itemList: callList,
    concurrency,
    run: async (call) => {
      call.output = call.kind === 'silence'
        ? await runner.runSilence({ input: call.input, repeatIndex })
        : await runner.runRouter({ input: call.input, repeatIndex });
    },
  });

  const rowList = plan.positionList.map((position) => {
    const isSilence = position.type === TARGET_TYPE_MAP.silence;
    const verdictRow = isSilence
      ? buildSilenceRow({ position, call: silenceCallMap.get(`silence:${toUtteranceKey(position)}`) })
      : buildLexicalRow({ position, group: groupMap.get(toUtteranceKey(position)), isScaleEnabled });
    return {
      itemId: position.itemId, language: position.language, posId: position.posId, type: position.type, mode, repeatIndex,
      trigger: position.trigger,
      truthIsGap: position.truthIsGap,
      truthRationale: position.truthRationale,
      sourceList: position.sourceList,
      isProductionTriggered: position.isProductionTriggered,
      ...verdictRow,
    };
  });

  const rawList = callList.map((call) => ({
    kind: call.kind, role: call.role ?? null, itemId: call.itemId, utteranceIndex: call.utteranceIndex, mode, repeatIndex,
    input: call.input, output: call.output.routed ?? call.output.judged ?? null, skipReason: call.output.skipReason ?? null,
    capture: call.output.capture, pathError: call.output.pathError, isCacheHit: call.output.isCacheHit,
  }));
  return { rowList, rawList };
}
