import { listSilenceMarker } from './silence-marker.mjs';
import { TARGET_TYPE_MAP, CANDIDATE_SOURCE_MAP, CANDIDATE_SOURCE_LIST } from './eval-types.mjs';
import { SILENCE_TRIGGER_MS } from '../../../src/renderer/core/trigger/silence-trigger.js';

export function isSpanOverlap(spanA, spanB) {
  return spanA.start < spanB.end && spanB.start < spanA.end;
}

export function buildPosId({ type, start, end }) {
  return `${type}@${start}-${end}`;
}

// 무발화 표시 1개 = 후보 1개(N ≥ 5초). production 무발화 트리거도 같은 조건이라 두 출처에 모두 든다.
export function extractSilenceCandidateList({ text }) {
  return listSilenceMarker(text)
    .filter((marker) => marker.silenceMs >= SILENCE_TRIGGER_MS)
    .map((marker) => ({
      type: TARGET_TYPE_MAP.silence, start: marker.start, end: marker.end, trigger: marker.trigger,
      silenceMs: marker.silenceMs, sourceList: [...CANDIDATE_SOURCE_LIST],
    }));
}

// 무발화 표시 안의 숫자("7초")는 말이 아니므로 어휘 후보에서 뺀다.
export function dropSilenceMarkerOverlap({ text, candidateList }) {
  const markerList = listSilenceMarker(text);
  return candidateList.filter((candidate) => !markerList.some((marker) => isSpanOverlap(candidate, marker)));
}

// 같은 유형에서 구간이 겹치는 후보를 한 위치로 합치고 출처를 모은다.
export function mergeCandidateList({ text, candidateList }) {
  const groupList = [];
  for (const [type, typeList] of Map.groupBy(candidateList, (candidate) => candidate.type)) {
    const sortedList = [...typeList].sort((candidateA, candidateB) => candidateA.start - candidateB.start || candidateA.end - candidateB.end);
    let current = null;
    for (const candidate of sortedList) {
      if (current && candidate.start < current.end) {
        current.end = Math.max(current.end, candidate.end);
        current.memberList.push(candidate);
      } else {
        current = { type, start: candidate.start, end: candidate.end, memberList: [candidate] };
        groupList.push(current);
      }
    }
  }
  return groupList
    .map(({ type, start, end, memberList }) => {
      const sourceSet = new Set(memberList.flatMap((member) => member.sourceList || [member.source]));
      return {
        type,
        start,
        end,
        trigger: text.slice(start, end),
        sourceList: CANDIDATE_SOURCE_LIST.filter((source) => sourceSet.has(source)),
        productionKindList: [...new Set(memberList
          .filter((member) => member.source === CANDIDATE_SOURCE_MAP.production && member.kind)
          .map((member) => member.kind))],
        isApproximate: memberList.some((member) => member.isApproximate === true),
      };
    })
    .sort((positionA, positionB) => positionA.start - positionB.start || positionA.type.localeCompare(positionB.type));
}
