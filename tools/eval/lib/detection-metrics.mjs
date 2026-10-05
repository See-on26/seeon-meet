import { TARGET_TYPE_LIST, LANGUAGE_LIST } from './eval-types.mjs';

export const METRIC_KIND_MAP = { judge: 'judge', system: 'system' };

const PREDICT_KEY_MAP = {
  [METRIC_KIND_MAP.judge]: 'isJudgePass',
  [METRIC_KIND_MAP.system]: 'isSystemPass',
};

export const ALL_TYPE_KEY = 'all';

const RATE_KEY_LIST = ['precision', 'recall', 'f1', 'accuracy', 'gapRatio'];

const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);

// 공백 클래스 기준 혼동 행렬. 정밀도·재현율·F1 이 주 지표, 정확도·공백 비율은 참고다.
export function computeConfusion({ rowList, predictKey }) {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0;
  for (const row of rowList) {
    const isPredicted = row[predictKey] === true;
    if (row.truthIsGap && isPredicted) tp += 1;
    else if (row.truthIsGap) fn += 1;
    else if (isPredicted) fp += 1;
    else tn += 1;
  }
  const count = tp + fp + fn + tn;
  return {
    tp, fp, fn, tn, count,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    f1: ratio(2 * tp, 2 * tp + fp + fn),
    accuracy: ratio(tp + tn, count),
    gapRatio: ratio(tp + fn, count),
  };
}

// 경로 오류 행은 지표에서 빼고 개수만 따로 센다.
export function buildMetricTable({ rowList, metricKind }) {
  const predictKey = PREDICT_KEY_MAP[metricKind];
  const validList = rowList.filter((row) => !row.pathError);
  const table = { [ALL_TYPE_KEY]: computeConfusion({ rowList: validList, predictKey }) };
  for (const type of TARGET_TYPE_LIST) {
    table[type] = computeConfusion({ rowList: validList.filter((row) => row.type === type), predictKey });
  }
  return table;
}

const increase = (countMap, key) => { countMap[key] = (countMap[key] || 0) + 1; };

// 종료 사유(max_tokens 등)를 같이 세야 응답이 잘려 파싱이 실패한 것인지 보인다.
export function countPathError({ rowList }) {
  const byKindMap = {};
  const byStopReasonMap = {};
  for (const row of rowList) {
    if (!row.pathError) continue;
    increase(byKindMap, row.pathError);
    increase(byStopReasonMap, row.stopReason || '없음');
  }
  return { total: Object.values(byKindMap).reduce((sum, count) => sum + count, 0), byKindMap, byStopReasonMap };
}

// 놓친 것(FN)을 판정기 차단 사유와 시스템 단계(트리거 누락·판정 차단·척도 비활성)로 나눈다.
export function summarizeMissReason({ rowList }) {
  const judgeReasonMap = {};
  const systemReasonMap = {};
  for (const row of rowList) {
    if (row.pathError || !row.truthIsGap) continue;
    if (!row.isJudgePass) increase(judgeReasonMap, row.judgeReason || '사유 없음');
    if (!row.isSystemPass) {
      increase(systemReasonMap, row.systemMissReason === 'judge_block'
        ? `judge_block:${row.judgeReason || '사유 없음'}` : row.systemMissReason);
    }
  }
  return { judgeReasonMap, systemReasonMap };
}

function mean(valueList) {
  return valueList.reduce((sum, value) => sum + value, 0) / valueList.length;
}

// 반복마다 낸 지표의 평균·표본 표준편차. 값이 없는(분모 0) 반복은 뺀다.
export function summarizeRepeat({ tableList }) {
  const summary = {};
  for (const typeKey of [ALL_TYPE_KEY, ...TARGET_TYPE_LIST]) {
    summary[typeKey] = {};
    for (const rateKey of RATE_KEY_LIST) {
      const valueList = tableList.map((table) => table[typeKey][rateKey]).filter((value) => value !== null);
      if (!valueList.length) {
        summary[typeKey][rateKey] = { mean: null, std: null, n: 0 };
        continue;
      }
      const average = mean(valueList);
      const std = valueList.length > 1
        ? Math.sqrt(valueList.reduce((sum, value) => sum + (value - average) ** 2, 0) / (valueList.length - 1)) : null;
      summary[typeKey][rateKey] = { mean: average, std, n: valueList.length };
    }
  }
  return summary;
}

function buildMetricPair({ rowList }) {
  return {
    judge: buildMetricTable({ rowList, metricKind: METRIC_KIND_MAP.judge }),
    system: buildMetricTable({ rowList, metricKind: METRIC_KIND_MAP.system }),
  };
}

function summarizeMetricPair({ pairList }) {
  return {
    judge: summarizeRepeat({ tableList: pairList.map((pair) => pair.judge) }),
    system: summarizeRepeat({ tableList: pairList.map((pair) => pair.system) }),
  };
}

const filterLanguage = (rowList, language) => rowList.filter((row) => row.language === language);

// 모드 하나의 지표: 반복별 판정기·시스템 표(전체와 언어별), 평균·표준편차, FN 나누기.
export function buildModeMetrics({ mode, rowListByRepeat }) {
  const repeatList = rowListByRepeat.map((rowList, repeatIndex) => ({
    repeatIndex,
    ...buildMetricPair({ rowList }),
    pathError: countPathError({ rowList }),
    byLanguage: Object.fromEntries(LANGUAGE_LIST.map((language) => [language, buildMetricPair({ rowList: filterLanguage(rowList, language) })])),
  }));
  const allRowList = rowListByRepeat.flat();
  return {
    mode,
    // 언어별 위치 수(경로 오류 포함). 보고서가 그 언어 표를 낼지 정한다.
    languageRowCountMap: Object.fromEntries(LANGUAGE_LIST.map((language) => [language, filterLanguage(rowListByRepeat[0] || [], language).length])),
    repeatList,
    summary: {
      ...summarizeMetricPair({ pairList: repeatList }),
      byLanguage: Object.fromEntries(LANGUAGE_LIST.map((language) => [
        language, summarizeMetricPair({ pairList: repeatList.map((repeat) => repeat.byLanguage[language]) }),
      ])),
    },
    missReason: {
      ...summarizeMissReason({ rowList: allRowList }),
      byLanguage: Object.fromEntries(LANGUAGE_LIST.map((language) => [language, summarizeMissReason({ rowList: filterLanguage(allRowList, language) })])),
    },
  };
}

// 틀린 사례: 판정기 근거와 정답 근거를 나란히 둔다(회의록 3.1.6 (3) 오류 분석).
export function listErrorCase({ rowList }) {
  const errorList = [];
  for (const row of rowList) {
    if (row.pathError) continue;
    for (const metricKind of Object.values(METRIC_KIND_MAP)) {
      const predicted = row[PREDICT_KEY_MAP[metricKind]] === true;
      if (predicted === row.truthIsGap) continue;
      errorList.push({
        metric: metricKind, itemId: row.itemId, language: row.language, posId: row.posId, type: row.type, mode: row.mode, repeatIndex: row.repeatIndex,
        trigger: row.trigger, truthIsGap: row.truthIsGap, predicted, judgeReason: row.judgeReason,
        systemMissReason: row.systemMissReason, truthRationale: row.truthRationale, context: row.context,
      });
    }
  }
  return errorList;
}
