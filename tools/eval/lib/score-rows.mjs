import { buildUtteranceList, findPieceIndexByOffset } from './utterance-builder.mjs';
import { buildRouterInput, buildSilenceInput } from './router-context.mjs';
import { extractItemPositionList } from './extract-items.mjs';
import { isSpanOverlap } from './candidate-merge.mjs';
import { resolveLexicalVerdict } from './judge-runner.mjs';
import { mapWithConcurrency } from './concurrency.mjs';
import { TARGET_TYPE_MAP, CANDIDATE_SOURCE_MAP } from './eval-types.mjs';

export const SYSTEM_MISS_REASON_MAP = {
  triggerMiss: 'trigger_miss',
  judgeBlock: 'judge_block',
  scaleDisabled: 'scale_disabled',
};

// 판정 뒤 단계는 생성·전달 단계의 걸러냄이라 평가에서 우회한다. 보고서에 그대로 적는다.
export const BYPASSED_STAGE_LIST = [
  '무발화 게이트(슬라이드당·분당 1회)',
  '지시 쿨다운(4초)',
  '간격·중복 억제',
  'VLM 의 NONE(특정 불가·이미 설명함)',
  '값 존재 검사',
  '한 발화 후보 1건 선택(중재) — 보조 칸 isArbiterSelected 로만 남긴다',
];

// 라벨 위치를 지금 production 트리거·말주머니로 다시 뽑은 후보와 겹침으로 대조한다.
// production 을 받아온 뒤 트리거가 바뀌었으면 출처(sourceList)도 지금 기준이 된다.
export function buildScorePlan({ itemList, matcher }) {
  const positionList = [];
  const newCandidateList = [];
  const utteranceListMap = new Map();
  let nullCount = 0;
  for (const item of itemList) {
    const utteranceList = buildUtteranceList({ item });
    utteranceListMap.set(item.id, utteranceList);
    const currentList = extractItemPositionList({ item, matcher });
    for (const labeled of item.positionList) {
      if (labeled.isGap === null) {
        nullCount += 1;
        continue;
      }
      const current = currentList.find((candidate) => candidate.type === labeled.type && isSpanOverlap(candidate, labeled));
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
        sourceList: current ? current.sourceList : [],
        isProductionFired: current ? current.isProductionFired : false,
        utteranceIndex: findPieceIndexByOffset({ utteranceList, offset: labeled.start }),
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
    newCandidateList,
    progress: { scoredCount: positionList.length, nullCount, newCandidateCount: newCandidateList.length },
  };
}

function buildCallKey(position) {
  return position.type === TARGET_TYPE_MAP.silence
    ? `silence:${position.itemId}#${position.utteranceIndex}`
    : `router:${position.itemId}#${position.utteranceIndex}`;
}

function isAnchorOverlap({ anchorList, utterance, position }) {
  const spanList = anchorList
    .map((anchor) => ({ anchor, offset: utterance.text.indexOf(anchor) }))
    .filter(({ offset }) => offset >= 0)
    .map(({ anchor, offset }) => ({ start: utterance.start + offset, end: utterance.start + offset + anchor.length }));
  if (!spanList.length) return null;
  return spanList.some((span) => isSpanOverlap(span, position));
}

function buildSilenceRow({ position, call }) {
  const isPrecondition = call.output.skipReason === null || call.output.skipReason === undefined;
  const isJudgePass = isPrecondition && call.output.judged?.hasCue === true;
  return {
    isJudgePass,
    isGeneratable: isJudgePass,
    judgeReason: isPrecondition ? (call.output.judged?.reason || null) : `precondition:${call.output.skipReason}`,
    isTypeOnlyMatch: false,
    isArbiterSelected: null,
    isAnchorOverlap: null,
    context: { transcript: call.input.transcript },
    position,
  };
}

function buildLexicalRow({ position, call, utterance, isScaleEnabled }) {
  const verdict = resolveLexicalVerdict({ type: position.type, routed: call.output.routed, isScaleEnabled });
  return {
    isJudgePass: verdict.isJudgePass,
    isGeneratable: verdict.isGeneratable,
    judgeReason: verdict.isJudgePass ? null : verdict.blockReason,
    isTypeOnlyMatch: verdict.isTypeOnlyMatch,
    isArbiterSelected: verdict.isArbiterSelected,
    isAnchorOverlap: isAnchorOverlap({ anchorList: verdict.anchorList, utterance, position }),
    context: { utterance: call.input.utterance, before: call.input.before, after: call.input.after, candidateText: verdict.candidateText },
    position,
  };
}

function resolveSystemMissReason({ isProductionTriggered, isJudgePass, isGeneratable }) {
  if (!isProductionTriggered) return SYSTEM_MISS_REASON_MAP.triggerMiss;
  if (!isJudgePass) return SYSTEM_MISS_REASON_MAP.judgeBlock;
  if (!isGeneratable) return SYSTEM_MISS_REASON_MAP.scaleDisabled;
  return null;
}

// 발화마다 라우터 1회(같은 발화의 후보는 호출을 나눠 쓴다), 무발화 위치마다 판정기 1회를 부른다.
export async function evaluateScorePlan({ plan, mode, contextWindow, repeatIndex, runner, concurrency, isScaleEnabled }) {
  const callMap = new Map();
  for (const position of plan.positionList) {
    const key = buildCallKey(position);
    if (callMap.has(key)) continue;
    const utteranceList = plan.utteranceListMap.get(position.itemId);
    const isSilence = position.type === TARGET_TYPE_MAP.silence;
    callMap.set(key, {
      key,
      kind: isSilence ? 'silence' : 'router',
      itemId: position.itemId,
      utteranceIndex: position.utteranceIndex,
      input: isSilence
        ? buildSilenceInput({ utteranceList, index: position.utteranceIndex, mode })
        : buildRouterInput({ utteranceList, index: position.utteranceIndex, contextWindow }),
    });
  }
  const callList = [...callMap.values()];
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
    const call = callMap.get(buildCallKey(position));
    const utterance = plan.utteranceListMap.get(position.itemId)[position.utteranceIndex];
    const isProductionTriggered = position.sourceList.includes(CANDIDATE_SOURCE_MAP.production);
    const base = {
      itemId: position.itemId, language: position.language, posId: position.posId, type: position.type, mode, repeatIndex,
    };
    if (call.output.pathError) {
      return {
        ...base, truthIsGap: position.truthIsGap, pathError: call.output.pathError,
        stopReason: call.output.capture?.stopReason ?? null, isProductionTriggered,
      };
    }
    const verdictRow = position.type === TARGET_TYPE_MAP.silence
      ? buildSilenceRow({ position, call })
      : buildLexicalRow({ position, call, utterance, isScaleEnabled });
    const isSystemPass = isProductionTriggered && verdictRow.isJudgePass && verdictRow.isGeneratable;
    return {
      ...base,
      trigger: position.trigger,
      truthIsGap: position.truthIsGap,
      truthRationale: position.truthRationale,
      sourceList: position.sourceList,
      isProductionTriggered,
      isProductionFired: position.isProductionFired,
      pathError: null,
      isJudgePass: verdictRow.isJudgePass,
      isSystemPass,
      judgeReason: verdictRow.judgeReason,
      systemMissReason: isSystemPass ? null : resolveSystemMissReason({ isProductionTriggered, ...verdictRow }),
      isTypeOnlyMatch: verdictRow.isTypeOnlyMatch,
      isArbiterSelected: verdictRow.isArbiterSelected,
      isAnchorOverlap: verdictRow.isAnchorOverlap,
      context: verdictRow.context,
    };
  });

  const rawList = callList.map((call) => ({
    kind: call.kind, itemId: call.itemId, utteranceIndex: call.utteranceIndex, mode, repeatIndex,
    input: call.input, output: call.output.routed ?? call.output.judged ?? null, skipReason: call.output.skipReason ?? null,
    capture: call.output.capture, pathError: call.output.pathError, isCacheHit: call.output.isCacheHit,
  }));
  return { rowList, rawList };
}
