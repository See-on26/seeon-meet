import { TARGET_TYPE_LIST, TARGET_TYPE_CODE_MAP, TARGET_TYPE_LABEL_MAP, LANGUAGE_LIST } from './eval-types.mjs';
import { ALL_TYPE_KEY, METRIC_KIND_MAP } from './detection-metrics.mjs';
import { BYPASSED_STAGE_LIST } from './score-rows.mjs';

const METRIC_TITLE_MAP = {
  [METRIC_KIND_MAP.judge]: '판정기 성능 — 그 위치를 판정기에 넣었을 때 넘김 (트리거 차이와 무관)',
  [METRIC_KIND_MAP.system]: '시스템 성능 — production 트리거가 잡음 + 판정기 넘김 + 생성 대상',
};

const LANGUAGE_LABEL_MAP = { ko: '한국어', en: '영어' };

// 측정만 하고 고치지 않는 production 차이. 시스템 성능의 trigger_miss 를 읽을 때 함께 본다.
export const KNOWN_PRODUCTION_GAP_LIST = [
  'production 트리거는 한국어 글자열만 본다. 영어 항목은 숫자+%를 빼면 시스템 성능에서 대부분 trigger_miss(트리거 누락)로 센다.',
  'production 2-2 트리거는 색(+쪽·선·것 등)만 잡는다. 싼·어두운·큰 + 쪽·부분·곳은 trigger_miss 다.',
  '3-3 추상적 척도는 production 트리거가 없고, 판정기가 넘겨도 기본 설정(SEEON_ROUTER_SCALE_ENABLED 없음)에서는 생성하지 않는다(scale_disabled).',
];

const formatWindowMs = (ms) => (ms === null || ms === undefined ? '항목 전체' : `${ms / 1000}초`);
const formatContextWindow = (contextWindow) => `앞 ${formatWindowMs(contextWindow.beforeMs)}·뒤 ${formatWindowMs(contextWindow.afterMs)}`;

const formatPercent = (value) => (value === null || value === undefined ? '–' : `${(value * 100).toFixed(1)}%`);

function formatRate({ summaryCell, repeatCount }) {
  if (summaryCell.mean === null) return '–';
  if (repeatCount <= 1 || summaryCell.std === null) return formatPercent(summaryCell.mean);
  return `${formatPercent(summaryCell.mean)} ± ${(summaryCell.std * 100).toFixed(1)}`;
}

function formatTypeLabel(typeKey) {
  return typeKey === ALL_TYPE_KEY ? '전체' : `${TARGET_TYPE_CODE_MAP[typeKey]} ${TARGET_TYPE_LABEL_MAP[typeKey]}`;
}

function buildMetricTable({ title, firstTable, summary, repeatCount }) {
  const lineList = [
    title,
    '',
    '| 유형 | 후보 | 공백 비율 | TP | FP | FN | TN | 정밀도 | 재현율 | F1 | 정확도(참고) |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const typeKey of [...TARGET_TYPE_LIST, ALL_TYPE_KEY]) {
    const counts = firstTable[typeKey];
    const rate = (rateKey) => formatRate({ summaryCell: summary[typeKey][rateKey], repeatCount });
    lineList.push(`| ${formatTypeLabel(typeKey)} | ${counts.count} | ${formatPercent(counts.gapRatio)} | ${counts.tp} | ${counts.fp} | ${counts.fn} | ${counts.tn}`
      + ` | ${rate('precision')} | ${rate('recall')} | ${rate('f1')} | ${rate('accuracy')} |`);
  }
  if (repeatCount > 1) lineList.push('', `개수는 반복 1 기준, 비율은 반복 ${repeatCount}회 평균 ± 표본 표준편차(%p).`);
  return lineList.join('\n');
}

function buildCountList(countMap) {
  const entryList = Object.entries(countMap).sort((entryA, entryB) => entryB[1] - entryA[1]);
  return entryList.length ? entryList.map(([key, count]) => `- ${key}: ${count}`).join('\n') : '- 없음';
}

function buildMetricPairSection({ heading, firstPair, summaryPair, repeatCount }) {
  return [
    buildMetricTable({ title: `${heading} ${METRIC_TITLE_MAP[METRIC_KIND_MAP.judge]}`, firstTable: firstPair.judge, summary: summaryPair.judge, repeatCount }),
    '',
    buildMetricTable({ title: `${heading} ${METRIC_TITLE_MAP[METRIC_KIND_MAP.system]}`, firstTable: firstPair.system, summary: summaryPair.system, repeatCount }),
  ].join('\n');
}

function buildLanguageSectionList(modeMetrics) {
  const [firstRepeat] = modeMetrics.repeatList;
  // 경로 오류로 지표 칸이 비어도 그 언어 위치가 있으면 표를 낸다.
  return LANGUAGE_LIST
    .filter((language) => modeMetrics.languageRowCountMap[language] > 0)
    .map((language) => [
      buildMetricPairSection({
        heading: `#### ${LANGUAGE_LABEL_MAP[language]}`, firstPair: firstRepeat.byLanguage[language],
        summaryPair: modeMetrics.summary.byLanguage[language], repeatCount: modeMetrics.repeatList.length,
      }),
      '',
      `${LANGUAGE_LABEL_MAP[language]} 시스템 성능의 FN`,
      buildCountList(modeMetrics.missReason.byLanguage[language].systemReasonMap),
    ].join('\n'));
}

function buildModeSection(modeMetrics) {
  const formatCountMap = (countMap) => Object.entries(countMap).map(([key, count]) => `${key} ${count}`).join(', ');
  const pathErrorList = modeMetrics.repeatList.map((repeat) => `반복 ${repeat.repeatIndex + 1}: ${repeat.pathError.total}건`
    + (repeat.pathError.total
      ? ` (${formatCountMap(repeat.pathError.byKindMap)} · 종료 사유 ${formatCountMap(repeat.pathError.byStopReasonMap)})` : ''));
  return [
    `## 모드 ${modeMetrics.mode}`,
    '',
    buildMetricPairSection({
      heading: '###', firstPair: modeMetrics.repeatList[0], summaryPair: modeMetrics.summary, repeatCount: modeMetrics.repeatList.length,
    }),
    '',
    '### 놓친 것(FN) 나누기 — 모든 반복 합계',
    '',
    '판정기 성능의 FN (판정 차단 사유)',
    buildCountList(modeMetrics.missReason.judgeReasonMap),
    '',
    '시스템 성능의 FN (trigger_miss = 트리거 누락, judge_block = 판정 차단, scale_disabled = 척도 비활성)',
    buildCountList(modeMetrics.missReason.systemReasonMap),
    '',
    '### 언어별',
    '',
    ...buildLanguageSectionList(modeMetrics).flatMap((section) => [section, '']),
    '### 경로 오류 (지표에서 뺌)',
    '',
    ...pathErrorList.map((line) => `- ${line}`),
  ].join('\n');
}

export function buildDetectionReport({ runInfo, modeMetricsList }) {
  return [
    '# 3.1 탐지 평가 결과',
    '',
    `- 실행: ${runInfo.startedAt} · 입력 ${runInfo.inputPath}`,
    `- 채점 위치 ${runInfo.progress.scoredCount}개 · 라벨 안 붙은 위치(null) ${runInfo.progress.nullCount}개 · 라벨 파일에 없는 새 후보 ${runInfo.progress.newCandidateCount}개`,
    `- 판정 모델 ${runInfo.judgeModelId} · 라우터 경로 ${runInfo.routerMode} · 척도 생성 ${runInfo.isScaleEnabled ? '켜짐' : '꺼짐(기본)'}`,
    `- 한국어 말주머니 매처 ${runInfo.matcherKind}${runInfo.matcherVersion ? ` ${runInfo.matcherVersion}` : ''}`
      + `${runInfo.isApproximate ? ' — 근사(어절 경계 정규식)' : ''} · 영어는 단어 경계 대조`,
    `- 모드 ${runInfo.modeList.join(', ')} · 반복 ${runInfo.repeatCount}회 · 동시 호출 ${runInfo.concurrency} · 캐시 ${runInfo.cacheDir || '끔'}`,
    `- 맥락 창(${runInfo.contextPreset}) ${runInfo.modeList.map((mode) => `${mode} ${formatContextWindow(runInfo.contextWindowMap[mode])}`).join(' / ')}`,
    ...(runInfo.contextPreset === 'production'
      ? ['- 알려진 차이: 실회의 균형 모드는 look-ahead 2.5초 + 보류 2.5초만 기다려, 뒤 맥락 7초 창에 실제로 모이는 ASR 은 약 5초 분량이다.']
      : []),
    `- 기준 커밋 HEAD ${runInfo.git.head || '?'} · production ${runInfo.git.productionMergeBase || '?'}`,
    '',
    '판정 뒤 단계는 우회했다(생성·전달 단계의 걸러냄이라 판정 성능이 아니다):',
    ...BYPASSED_STAGE_LIST.map((stage) => `- ${stage}`),
    '',
    '알려진 production 차이(측정만 한다):',
    ...KNOWN_PRODUCTION_GAP_LIST.map((gap) => `- ${gap}`),
    '',
    '한계: production 은 1.5~2.5초 ASR 조각마다 트리거를 보지만 이 도구는 문장 단위다. 맥락 창은 같은 함수(TranscriptWindow)로 만들지만 조각 경계 효과는 재현하지 않는다.'
      + ' 시각이 없는 전사는 어절(영어는 단어)당 0.45초로 추정한다. 판정 모델 temperature 를 고정하지 않으므로 --repeat 로 분산을 본다.',
    '',
    ...modeMetricsList.map((modeMetrics) => buildModeSection(modeMetrics)),
    '',
  ].join('\n');
}
