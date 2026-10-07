import { extractProductionCandidateList } from './production-trigger.mjs';
import {
  mergeCandidateList, extractSilenceCandidateList, dropSilenceMarkerOverlap, isSpanOverlap, buildPosId,
} from './candidate-merge.mjs';
import { TARGET_TYPE_LIST, CANDIDATE_SOURCE_MAP, LANGUAGE_LIST } from './eval-types.mjs';

// 후보 = production 트리거(main speech-trigger.js, 발화마다) ∪ 회의록 말주머니 ∪ [무발화 N초](N ≥ 5).
// production 은 조각에서 뽑은 후보를 모두 판단 LLM 에 넘기므로 production 출처 위치는 모두 판단 대상이다.
// productionCandidateList 를 주면(채점이 미리 뽑아 둔 것) 트리거를 다시 돌리지 않는다.
export function extractItemPositionList({
  item, matcher, productionTrigger, productionCandidateList = extractProductionCandidateList({ item, productionTrigger }),
}) {
  const text = item.transcript;
  const lexicalList = dropSilenceMarkerOverlap({
    text, candidateList: [...productionCandidateList, ...matcher.match({ text, language: item.language })],
  });
  return mergeCandidateList({ text, candidateList: [...lexicalList, ...extractSilenceCandidateList({ text })] });
}

const WORD_BOUNDARY_PATTERN = /[\s\p{P}]/u;
const isWordStart = (text, index) => index === 0 || WORD_BOUNDARY_PATTERN.test(text[index - 1]);
const isWordEnd = (text, index) => index === text.length || WORD_BOUNDARY_PATTERN.test(text[index]);

function listOccurrenceSpan(text, needle) {
  const spanList = [];
  for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + 1)) {
    spanList.push({ start, end: start + needle.length });
  }
  return spanList;
}

// 후보 구간이 트리거 자리와 얼마나 같은지(겹친 길이 ÷ 합친 길이).
function measureSpanMatch(position, span) {
  const overlap = Math.min(position.end, span.end) - Math.max(position.start, span.start);
  const union = Math.max(position.end, span.end) - Math.min(position.start, span.start);
  return union > 0 ? overlap / union : 0;
}

// 목표 트리거가 여러 번 나온 전사에서 자리 하나의 점수. 겹치는 같은 유형 후보가 낱말 경계에서 시작해야 하고
// (다른 낱말 안의 "분이거든요" 의 이거는 빠진다), 적힌 꼴 그대로 한 낱말인 자리("저기요" 가 아닌 "저기")와
// 후보 구간이 트리거와 더 같은 자리를 앞세운다.
function scoreOccurrence({ text, span, sameTypeList }) {
  const candidateList = sameTypeList.filter((position) => isSpanOverlap(position, span) && isWordStart(text, position.start));
  if (!candidateList.length) return null;
  const position = candidateList.reduce((best, current) => (measureSpanMatch(current, span) > measureSpanMatch(best, span) ? current : best));
  return {
    position,
    scoreList: [isWordStart(text, span.start) && isWordEnd(text, span.end) ? 1 : 0, measureSpanMatch(position, span)],
  };
}

const compareScoreList = (scoreListA, scoreListB) => scoreListA.reduce((result, score, index) => result || score - scoreListB[index], 0);

// 데이터를 만들 때 알고 있는 목표 트리거가 있으면, 그 자리와 겹치는 같은 유형 후보를 목표 위치로 본다.
// 트리거가 한 번만 나오면 그 자리, 여러 번 나오면 scoreOccurrence 로 한 자리를 고른다.
// 가장 나은 자리가 둘 이상이거나 낱말 경계에서 시작하는 후보가 없으면 고르지 않는다(isAmbiguous).
// 틀린 자리에 정답을 채우면 라벨이 조용히 틀린다.
export function resolveTargetPosition({ item, positionList }) {
  const none = { position: null, isAmbiguous: false };
  if (!item.targetTrigger) return none;
  const text = item.transcript;
  const spanList = listOccurrenceSpan(text, item.targetTrigger);
  const sameTypeList = positionList.filter((position) => position.type === item.targetType);
  if (spanList.length === 1) {
    return { position: sameTypeList.find((position) => isSpanOverlap(position, spanList[0])) || null, isAmbiguous: false };
  }
  const hasAnyCandidate = spanList.some((span) => sameTypeList.some((position) => isSpanOverlap(position, span)));
  if (!hasAnyCandidate) return none;
  const scoredList = spanList.map((span) => scoreOccurrence({ text, span, sameTypeList })).filter(Boolean)
    .sort((scoredA, scoredB) => compareScoreList(scoredB.scoreList, scoredA.scoreList));
  const isUnique = scoredList.length === 1 || (scoredList.length > 1 && compareScoreList(scoredList[0].scoreList, scoredList[1].scoreList) > 0);
  return isUnique ? { position: scoredList[0].position, isAmbiguous: false } : { position: null, isAmbiguous: true };
}

export function findTargetPosition({ item, positionList }) {
  return resolveTargetPosition({ item, positionList }).position;
}

// extract 가 목표 위치에 미리 채우는 값. 항목에 isTargetGap 이 없거나 목표 위치를 못 고르면 null.
// 초안 한 줄(항목 칸 + positionList)을 넣으면 그 초안을 쓸 때 미리 채운 값을 다시 구한다.
export function resolveTargetPrefill({ item, positionList }) {
  if (typeof item.isTargetGap !== 'boolean') return null;
  const position = findTargetPosition({ item, positionList });
  return position ? { position, isGap: item.isTargetGap, rationale: item.targetRationale || '' } : null;
}

// 라벨 칸을 비운 초안. 목표 위치에만 isTargetGap·targetRationale 을 미리 채운다.
export function buildLabelDraft({ item, positionList }) {
  const prefill = resolveTargetPrefill({ item, positionList });
  return {
    ...item,
    positionList: positionList.map((position) => {
      const isPrefilled = position === prefill?.position;
      return {
        posId: buildPosId(position),
        type: position.type,
        start: position.start,
        end: position.end,
        trigger: position.trigger,
        sourceList: position.sourceList,
        isApproximate: position.isApproximate,
        isGap: isPrefilled ? prefill.isGap : null,
        rationale: isPrefilled ? prefill.rationale : '',
      };
    }),
  };
}

export function summarizeExtraction({ draftList, matcher, productionTrigger }) {
  const typeSummaryMap = Object.fromEntries(TARGET_TYPE_LIST.map((type) => [type, {
    count: 0, productionCount: 0, methodologyCount: 0, bothCount: 0,
  }]));
  let prefilledCount = 0;
  const missingTargetIdList = [];
  const ambiguousTargetIdList = [];
  const languageCountMap = Object.fromEntries(LANGUAGE_LIST.map((language) => [language, 0]));
  for (const draft of draftList) {
    languageCountMap[draft.language] = (languageCountMap[draft.language] || 0) + 1;
    for (const position of draft.positionList) {
      const summary = typeSummaryMap[position.type];
      const isProduction = position.sourceList.includes(CANDIDATE_SOURCE_MAP.production);
      const isMethodology = position.sourceList.includes(CANDIDATE_SOURCE_MAP.methodology);
      summary.count += 1;
      if (isProduction) summary.productionCount += 1;
      if (isMethodology) summary.methodologyCount += 1;
      if (isProduction && isMethodology) summary.bothCount += 1;
      if (position.isGap !== null) prefilledCount += 1;
    }
    if (draft.targetTrigger) {
      const { position, isAmbiguous } = resolveTargetPosition({ item: draft, positionList: draft.positionList });
      if (isAmbiguous) ambiguousTargetIdList.push(draft.id);
      else if (!position) missingTargetIdList.push(draft.id);
    }
  }
  return {
    itemCount: draftList.length,
    positionCount: draftList.reduce((sum, draft) => sum + draft.positionList.length, 0),
    typeSummaryMap,
    languageCountMap,
    prefilledCount,
    missingTargetIdList,
    ambiguousTargetIdList,
    matcherKind: matcher.kind,
    isApproximate: matcher.isApproximate,
    productionKoreanAnalyzer: productionTrigger?.koreanAnalyzer ?? null,
  };
}
