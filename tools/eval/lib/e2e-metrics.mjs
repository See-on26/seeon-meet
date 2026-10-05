import { CONDITION_LIST } from './e2e-material.mjs';
import { ANSWER_SOURCE_MAP } from './answer-parse.mjs';

const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);

// "알 수 없음"은 오답으로 센다. 응답 오류(답 번호를 못 읽음·요청 실패)는 정답률 분모에서 빼고 따로 센다.
// textAnswerCount 는 요청한 JSON 이 아닌 글 답에서 읽은 답 수, requestFailCount 는 응답 오류 가운데 요청 자체가 실패한 수다.
function summarizeCondition(answerList) {
  const validList = answerList.filter((answer) => !answer.isResponseError);
  const correctCount = validList.filter((answer) => answer.isCorrect).length;
  const unknownCount = validList.filter((answer) => answer.isUnknown).length;
  return {
    answeredCount: validList.length,
    correctCount,
    unknownCount,
    errorCount: answerList.length - validList.length,
    textAnswerCount: validList.filter((answer) => answer.source === ANSWER_SOURCE_MAP.text).length,
    requestFailCount: answerList.filter((answer) => answer.isResponseError && answer.errorMessage).length,
    ca: ratio(correctCount, validList.length),
    unknownRatio: ratio(unknownCount, validList.length),
  };
}

// 조건(또는 필터)별 답한 수·정답·알 수 없음·응답 오류·글 답 수.
export function summarizeConditionMap({ answerList, conditionList = CONDITION_LIST }) {
  return Object.fromEntries(conditionList.map((condition) => [
    condition, summarizeCondition(answerList.filter((answer) => answer.condition === condition)),
  ]));
}

const subtractOrNull = (left, right) => (left === null || right === null ? null : left - right);
const divideOrNull = (numerator, denominator) => (numerator === null || !denominator ? null : numerator / denominator);
const toPairKey = (answer) => `${answer.questionId}#${answer.repeatIndex}`;

// 같은 문항·반복(questionId#repeatIndex)에서 pairConditionList 의 조건이 모두 답한(응답 오류·건너뜀이 아닌) 짝만 남겨
// 조건별 정답률을 다시 센다. 조건마다 답한 문항이 다르면(C 를 건너뛴 영상, 응답 오류) 서로 다른 문항을 견주게 된다.
function summarizePairedCa({ answerList, pairConditionList }) {
  const validKeySetList = pairConditionList.map((condition) => new Set(answerList
    .filter((answer) => answer.condition === condition && !answer.isResponseError).map(toPairKey)));
  const pairKeySet = new Set([...validKeySetList[0]].filter((key) => validKeySetList.every((keySet) => keySet.has(key))));
  const caOf = (condition) => summarizeCondition(answerList.filter((answer) => answer.condition === condition
    && pairKeySet.has(toPairKey(answer)))).ca;
  return { pairCount: pairKeySet.size, caOf };
}

// 도달률 S÷C, 도달률 증가폭 (S−A)÷C, Accuracy Ratio (S−A)÷(H−A).
// 도달률은 S·C 짝, 증가폭은 A·S·C 짝으로 센다(짝 수 reachPairCount·reachGainPairCount).
// AR 은 사람 작성 AD 가 있는 문항끼리 비교해야 하므로 A·S 도 H 답이 있는(응답 오류가 아닌) 문항만으로 다시 센다.
export function computeDerivedMetric({ answerList }) {
  const conditionMap = summarizeConditionMap({ answerList });
  const humanKeySet = new Set(answerList
    .filter((answer) => answer.condition === 'H' && !answer.isResponseError).map(toPairKey));
  const withHuman = (condition) => summarizeCondition(answerList.filter((answer) => answer.condition === condition
    && humanKeySet.has(toPairKey(answer)))).ca;
  const caOf = (condition) => conditionMap[condition].ca;
  const reachPair = summarizePairedCa({ answerList, pairConditionList: ['S', 'C'] });
  const reachGainPair = summarizePairedCa({ answerList, pairConditionList: ['A', 'S', 'C'] });
  return {
    conditionMap,
    reachRate: divideOrNull(reachPair.caOf('S'), reachPair.caOf('C')),
    reachPairCount: reachPair.pairCount,
    reachGain: divideOrNull(subtractOrNull(reachGainPair.caOf('S'), reachGainPair.caOf('A')), reachGainPair.caOf('C')),
    reachGainPairCount: reachGainPair.pairCount,
    accuracyRatio: divideOrNull(subtractOrNull(withHuman('S'), withHuman('A')), subtractOrNull(caOf('H'), withHuman('A'))),
  };
}

const groupBy = (answerList, toKey) => Object.fromEntries([...Map.groupBy(answerList, toKey)]
  .map(([key, groupList]) => [key, computeDerivedMetric({ answerList: groupList })]));

// 보고 단위: 도메인 × 조각/통합 × 소분류(회의록 3.2.4). 각 축 합계도 함께 낸다.
export function buildE2eMetrics({ answerList }) {
  return {
    overall: computeDerivedMetric({ answerList }),
    byDomain: groupBy(answerList, (answer) => answer.domain),
    byLanguage: groupBy(answerList, (answer) => answer.language || '언어 미지정'),
    byCategory: groupBy(answerList, (answer) => answer.category),
    bySubcategory: groupBy(answerList, (answer) => answer.subcategory),
    byGroup: groupBy(answerList, (answer) => `${answer.domain} · ${answer.category} · ${answer.subcategory}`),
  };
}

function summarizeValueList(valueList) {
  const presentList = valueList.filter((value) => value !== null);
  if (!presentList.length) return { mean: null, std: null, n: 0 };
  const mean = presentList.reduce((sum, value) => sum + value, 0) / presentList.length;
  const std = presentList.length > 1
    ? Math.sqrt(presentList.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (presentList.length - 1)) : null;
  return { mean, std, n: presentList.length };
}

// --repeat 반복별 전체 지표의 평균·표본 표준편차.
export function summarizeRepeatMetric({ answerList }) {
  const repeatMetricList = [...Map.groupBy(answerList, (answer) => answer.repeatIndex).values()]
    .map((repeatAnswerList) => computeDerivedMetric({ answerList: repeatAnswerList }));
  return {
    repeatCount: repeatMetricList.length,
    caMap: Object.fromEntries(CONDITION_LIST.map((condition) => [
      condition, summarizeValueList(repeatMetricList.map((metric) => metric.conditionMap[condition].ca)),
    ])),
    reachRate: summarizeValueList(repeatMetricList.map((metric) => metric.reachRate)),
    reachGain: summarizeValueList(repeatMetricList.map((metric) => metric.reachGain)),
    accuracyRatio: summarizeValueList(repeatMetricList.map((metric) => metric.accuracyRatio)),
  };
}
