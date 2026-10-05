import {
  detectDeixis, ACTIVE_KIND_LIST, DEIXIS_KIND_MAP,
} from '../../../src/renderer/core/trigger/deixis-detector.js';
import { TARGET_TYPE_MAP, CANDIDATE_SOURCE_MAP } from './eval-types.mjs';

// 가림 문자는 한글·영문·숫자·공백이 아니어야 가린 자리에서 새 일치가 생기지 않는다.
export const MASK_CHAR = '#';

const MAX_MATCH_PER_KIND = 200;

// 숫자나 한자 수사(십·백·천·만·억)로 시작하는 data 트리거는 숫자+단위·% 이므로 3-1 단순 수치다.
const VALUE_TRIGGER_PATTERN = /\d|^[일이삼사오육칠팔구]?[십백천만억]/;

export function classifyDataTrigger(trigger) {
  return VALUE_TRIGGER_PATTERN.test(trigger) ? TARGET_TYPE_MAP.value : TARGET_TYPE_MAP.change;
}

// production kind → 평가 유형. demonstrative·pointing 은 2-1, color 는 2-2(형용사+지시 명사), data 는 3-1·3-2 로 나눈다.
// production 2-2 트리거는 색(+쪽·선·것 등)만 잡는다. 싼·어두운·큰 + 쪽·부분·곳은 잡지 못한다(평가는 측정만 한다).
export function resolveTargetType({ kind, trigger }) {
  if (kind === DEIXIS_KIND_MAP.data) return classifyDataTrigger(trigger);
  if (kind === DEIXIS_KIND_MAP.color) return TARGET_TYPE_MAP.adjectiveNoun;
  if (kind === DEIXIS_KIND_MAP.demonstrative || kind === DEIXIS_KIND_MAP.pointing) return TARGET_TYPE_MAP.demonstrative;
  return null;
}

function maskSpan({ text, start, end }) {
  return text.slice(0, start) + MASK_CHAR.repeat(end - start) + text.slice(end);
}

// detectDeixis 는 조각당 첫 일치 1건만 준다. kind 별로 따로 부르고, 맞은 구간을 가린 뒤 다시 불러 모든 구간을 뽑는다.
export function extractProductionCandidateList({ text, kindList = ACTIVE_KIND_LIST }) {
  const candidateList = [];
  for (const kind of kindList) {
    const activeKindSet = new Set([kind]);
    let masked = text;
    for (let count = 0; count < MAX_MATCH_PER_KIND; count += 1) {
      const result = detectDeixis(masked, { activeKindSet });
      if (!result.isDeixis) break;
      const start = masked.indexOf(result.trigger);
      if (start < 0) break;
      const end = start + result.trigger.length;
      const type = resolveTargetType({ kind, trigger: result.trigger });
      if (type) {
        candidateList.push({
          type, start, end, trigger: text.slice(start, end), kind, source: CANDIDATE_SOURCE_MAP.production,
        });
      }
      masked = maskSpan({ text: masked, start, end });
    }
  }
  return candidateList.sort((candidateA, candidateB) => candidateA.start - candidateB.start || candidateA.end - candidateB.end);
}

// 제품의 DeixisDetector 와 같은 활성 종류로 조각 하나에서 실제로 발동하는 1건.
export function detectProductionFiredTrigger({ text }) {
  const result = detectDeixis(text, { activeKindSet: new Set(ACTIVE_KIND_LIST) });
  if (!result.isDeixis) return null;
  const start = text.indexOf(result.trigger);
  return {
    kind: result.kind,
    trigger: result.trigger,
    type: resolveTargetType(result),
    start,
    end: start < 0 ? -1 : start + result.trigger.length,
  };
}
