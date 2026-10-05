import { extractProductionCandidateList, detectProductionFiredTrigger } from './production-trigger.mjs';
import { buildUtteranceList, PIECE_KIND_MAP } from './utterance-builder.mjs';
import {
  mergeCandidateList, extractSilenceCandidateList, dropSilenceMarkerOverlap, isSpanOverlap, buildPosId,
} from './candidate-merge.mjs';
import { TARGET_TYPE_LIST, CANDIDATE_SOURCE_MAP, LANGUAGE_LIST } from './eval-types.mjs';

// production 은 조각마다 첫 일치 1건만 발동한다. 발화(문장)마다 그 1건의 구간을 구한다.
export function listProductionFiredSpan({ item }) {
  return buildUtteranceList({ item })
    .filter((piece) => piece.kind === PIECE_KIND_MAP.speech)
    .map((piece) => ({ piece, fired: detectProductionFiredTrigger({ text: piece.text }) }))
    .filter(({ fired }) => fired && fired.start >= 0 && fired.type)
    .map(({ piece, fired }) => ({
      type: fired.type, kind: fired.kind, trigger: fired.trigger, start: piece.start + fired.start, end: piece.start + fired.end,
    }));
}

// 후보 = production 트리거 ∪ 회의록 말주머니 ∪ [무발화 N초](N ≥ 5).
// isProductionFired 는 그 위치가 production 이 실제로 발동하는 1건과 겹치는지다(보조 정보).
export function extractItemPositionList({ item, matcher }) {
  const text = item.transcript;
  const lexicalList = dropSilenceMarkerOverlap({
    text, candidateList: [...extractProductionCandidateList({ text }), ...matcher.match({ text, language: item.language })],
  });
  const firedSpanList = listProductionFiredSpan({ item });
  return mergeCandidateList({ text, candidateList: [...lexicalList, ...extractSilenceCandidateList({ text })] })
    .map((position) => ({
      ...position,
      isProductionFired: firedSpanList.some((span) => span.type === position.type && isSpanOverlap(span, position)),
    }));
}

// 데이터를 만들 때 알고 있는 목표 트리거가 있으면, 그 첫 위치와 겹치는 같은 유형 후보를 찾는다.
export function findTargetPosition({ item, positionList }) {
  if (!item.targetTrigger) return null;
  const start = item.transcript.indexOf(item.targetTrigger);
  if (start < 0) return null;
  const targetSpan = { start, end: start + item.targetTrigger.length };
  return positionList.find((position) => position.type === item.targetType && isSpanOverlap(position, targetSpan)) || null;
}

// 라벨 칸을 비운 초안. 목표 위치에만 isTargetGap·targetRationale 을 미리 채운다.
export function buildLabelDraft({ item, positionList }) {
  const target = findTargetPosition({ item, positionList });
  return {
    ...item,
    positionList: positionList.map((position) => {
      const isPrefilled = position === target && typeof item.isTargetGap === 'boolean';
      return {
        posId: buildPosId(position),
        type: position.type,
        start: position.start,
        end: position.end,
        trigger: position.trigger,
        sourceList: position.sourceList,
        isProductionFired: position.isProductionFired,
        isApproximate: position.isApproximate,
        isGap: isPrefilled ? item.isTargetGap : null,
        rationale: isPrefilled ? (item.targetRationale || '') : '',
      };
    }),
  };
}

export function summarizeExtraction({ draftList, matcher }) {
  const typeSummaryMap = Object.fromEntries(TARGET_TYPE_LIST.map((type) => [type, {
    count: 0, productionCount: 0, methodologyCount: 0, bothCount: 0,
  }]));
  let prefilledCount = 0;
  const missingTargetIdList = [];
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
    if (draft.targetTrigger && !findTargetPosition({ item: draft, positionList: draft.positionList })) {
      missingTargetIdList.push(draft.id);
    }
  }
  return {
    itemCount: draftList.length,
    positionCount: draftList.reduce((sum, draft) => sum + draft.positionList.length, 0),
    typeSummaryMap,
    languageCountMap,
    prefilledCount,
    missingTargetIdList,
    matcherKind: matcher.kind,
    isApproximate: matcher.isApproximate,
  };
}
