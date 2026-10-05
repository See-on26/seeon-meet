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

function findOccurrenceList({ text, word }) {
  const occurrenceList = [];
  for (let index = text.indexOf(word); index >= 0; index = text.indexOf(word, index + 1)) {
    occurrenceList.push(index);
  }
  return occurrenceList;
}

// 한 자리만 남기고 같은 글자열의 다른 자리를 모두 가린다. 겹친 자리는 남길 구간 밖의 글자만 가린다.
function maskOtherOccurrence({ text, occurrenceList, keepStart, length }) {
  const charList = text.split('');
  const keepEnd = keepStart + length;
  for (const otherStart of occurrenceList) {
    if (otherStart === keepStart) continue;
    for (let index = otherStart; index < otherStart + length; index += 1) {
      if (index < keepStart || index >= keepEnd) charList[index] = MASK_CHAR;
    }
  }
  return charList.join('');
}

// detectDeixis 는 글자열만 주고 자리를 주지 않는다. (^|\s) 로 시작하는 정규식(지시 관형사+명사·구어 방향)은
// "많이 차이가"·"금요일로"처럼 앞 낱말 속 같은 글자열보다 뒤에서 맞을 수 있어 indexOf 만으로는 자리가 틀린다.
// 같은 글자열이 여럿이면 앞에서부터 한 자리만 남기고 나머지를 가려 다시 불러, 같은 { kind, trigger } 가 나오는 첫 자리를 쓴다.
// 글자열 포함으로 잡는 트리거는 어느 자리를 남겨도 같은 결과라 첫 자리가 된다. 자리를 정하지 못하면 -1.
function locateTrigger({ masked, result, activeKindSet }) {
  const occurrenceList = findOccurrenceList({ text: masked, word: result.trigger });
  if (occurrenceList.length <= 1) return occurrenceList[0] ?? -1;
  for (const keepStart of occurrenceList) {
    const probe = maskOtherOccurrence({
      text: masked, occurrenceList, keepStart, length: result.trigger.length,
    });
    const probeResult = detectDeixis(probe, { activeKindSet });
    if (probeResult.kind === result.kind && probeResult.trigger === result.trigger) return keepStart;
  }
  return -1;
}

function findNextWhitespaceIndex({ text, from }) {
  for (let index = from + 1; index < text.length; index += 1) {
    if (/\s/.test(text[index])) return index;
  }
  return -1;
}

// detectDeixis 는 조각당 첫 일치 1건만 준다. kind 별로 따로 부르고, 맞은 구간을 가린 뒤 다시 불러 모든 구간을 뽑는다.
// 지시 관형사+명사는 첫 정규식 일치가 "그 때"·"이 정도"처럼 비지시 명사면 뒤를 보지 않고 null 을 준다.
// 그래서 null 이 나와도 글이 남았으면 다음 공백 앞까지 가리고 다시 부른다. 공백은 남겨 (^|\s) 기준이 그대로 걸리게 한다.
export function extractProductionCandidateList({ text, kindList = ACTIVE_KIND_LIST }) {
  const candidateList = [];
  for (const kind of kindList) {
    const activeKindSet = new Set([kind]);
    let masked = text;
    let cursor = 0;
    let matchCount = 0;
    while (matchCount < MAX_MATCH_PER_KIND) {
      const result = detectDeixis(masked, { activeKindSet });
      if (!result.isDeixis) {
        cursor = findNextWhitespaceIndex({ text: masked, from: cursor });
        if (cursor < 0) break;
        masked = maskSpan({ text: masked, start: 0, end: cursor });
        continue;
      }
      const start = locateTrigger({ masked, result, activeKindSet });
      // 자리를 정하지 못하면 가릴 구간이 없어 같은 결과만 되풀이되므로 이 kind 는 여기서 멈춘다.
      if (start < 0) break;
      const end = start + result.trigger.length;
      const type = resolveTargetType({ kind, trigger: result.trigger });
      if (type) {
        candidateList.push({
          type, start, end, trigger: text.slice(start, end), kind, source: CANDIDATE_SOURCE_MAP.production,
        });
      }
      masked = maskSpan({ text: masked, start, end });
      matchCount += 1;
    }
  }
  return candidateList.sort((candidateA, candidateB) => candidateA.start - candidateB.start || candidateA.end - candidateB.end);
}

// 제품의 DeixisDetector 와 같은 활성 종류로 조각 하나에서 실제로 발동하는 1건.
export function detectProductionFiredTrigger({ text }) {
  const activeKindSet = new Set(ACTIVE_KIND_LIST);
  const result = detectDeixis(text, { activeKindSet });
  if (!result.isDeixis) return null;
  const start = locateTrigger({ masked: text, result, activeKindSet });
  return {
    kind: result.kind,
    trigger: result.trigger,
    type: resolveTargetType(result),
    start,
    end: start < 0 ? -1 : start + result.trigger.length,
  };
}
