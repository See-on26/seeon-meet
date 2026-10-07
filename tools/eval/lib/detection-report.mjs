import { TARGET_TYPE_LIST, TARGET_TYPE_CODE_MAP, TARGET_TYPE_LABEL_MAP, LANGUAGE_LIST } from './eval-types.mjs';
import { ALL_TYPE_KEY, METRIC_KIND_MAP } from './detection-metrics.mjs';
import { BYPASSED_STAGE_LIST } from './score-rows.mjs';
import { KOREAN_TRIGGER_ANALYZER_MAP } from './production-trigger.mjs';

const METRIC_TITLE_MAP = {
  [METRIC_KIND_MAP.judge]: '판정기 성능 — 그 위치를 후보로 넣었을 때 판단 LLM 이 공백(O)으로 가림 (트리거 차이와 무관)',
  [METRIC_KIND_MAP.system]: '시스템 성능 — production 트리거가 잡음 + 그 후보 목록으로 판단 LLM 이 O + 생성 대상',
};

const LANGUAGE_LABEL_MAP = { ko: '한국어', en: '영어' };

// 측정만 하고 고치지 않는 production 차이. 시스템 성능의 trigger_miss 를 읽을 때 함께 본다.
export const KNOWN_PRODUCTION_GAP_LIST = [
  'production 트리거(main speech-trigger.js: 한국어는 Kiwi 품사, 영어는 규칙, 5유형)와 회의록 말주머니는 같은 목록이 아니다.'
    + ' 말주머니에만 있는 위치는 시스템 성능에서 trigger_miss(트리거 누락)로 센다. 어느 목록을 기준으로 삼을지는 팀이 정한다.',
  'production 은 판단 LLM 이 실패하거나 응답을 읽지 못하면 그 후보를 해설하지 않는다(X). 평가는 그런 호출을 경로 오류로 따로 센다.',
  '3-3 추상적 척도는 기본으로 생성한다. SEEON_ROUTER_SCALE_ENABLED=false 일 때만 판정기가 넘겨도 생성하지 않는다(scale_disabled).',
];

// 경로 오류 행을 지표에 넣는 규칙(detection-metrics.mjs resolveMetricRow)을 보고서에 그대로 적는다.
const PATH_ERROR_RULE_TEXT = '판정기 호출이 실패한 위치다. 판정기 성능에서는 판정 호출이 실패한 위치를 모두 뺀다.'
  + ' 시스템 성능에서는 production 트리거가 잡지 않은 위치를 늘 trigger_miss(놓침)로 넣는다 — production 은 그 위치에서 판정기를 부르지 않으므로 결과가 정해진다.'
  + ' 트리거가 잡은 위치는 production 후보만 넘긴 호출이 실패했으면 시스템 성능에서도 뺀다. 그래서 두 표의 후보 수가 다를 수 있다.'
  + ' 말주머니에만 있는 라벨 위치가 있는 발화는 판정기 성능용 호출(그 위치를 더한 후보 목록)과 시스템 성능용 호출(production 후보만)을 따로 부른다.';

const formatWindowMs = (ms) => (ms === null || ms === undefined ? '항목 전체' : `${ms / 1000}초`);
const formatContextWindow = (contextWindow) => `앞 ${formatWindowMs(contextWindow.beforeMs)}·뒤 ${formatWindowMs(contextWindow.afterMs)}`;

const formatPercent = (value) => (value === null || value === undefined ? '–' : `${(value * 100).toFixed(1)}%`);

// 경로 오류로 반복마다 분모가 달라 값이 없는(분모 0) 반복이 생긴다. 평균에 든 반복이 요청보다 적으면 (n=k) 로 알린다.
function formatRate({ summaryCell, repeatCount }) {
  if (summaryCell.mean === null) return '–';
  const spread = repeatCount > 1 && summaryCell.std !== null ? ` ± ${(summaryCell.std * 100).toFixed(1)}` : '';
  const sampleNote = summaryCell.n < repeatCount ? ` (n=${summaryCell.n})` : '';
  return `${formatPercent(summaryCell.mean)}${spread}${sampleNote}`;
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
  if (repeatCount > 1) {
    lineList.push('', `후보·공백 비율·TP·FP·FN·TN 은 반복 1 기준이고, 정밀도·재현율·F1·정확도는 반복 ${repeatCount}회 평균 ± 표본 표준편차(%p)다.`
      + ` 경로 오류로 반복마다 분모가 달라질 수 있어, 분모가 0 인 반복을 빼고 평균한 칸은 (n=평균에 든 반복 수) 를 붙인다.`);
  }
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

// 판정기 호출이 판정 LLM(GPU·Bedrock)에 닿지 못한(http·no_token) 실행은 표가 정상처럼 보여도 그 위치가 빠져 있으므로 맨 위에 알린다.
function buildRequestFailLine(requestFailure) {
  if (!requestFailure?.callCount) return [];
  const kindText = Object.entries(requestFailure.byKindMap).map(([kind, count]) => `${kind} ${count}`).join(' · ');
  return [`- **주의: 판정기 호출 ${requestFailure.callCount}회가 판정 LLM(GPU·Bedrock)에 닿지 못했다** (${kindText})`
    + ` — 판정 결과를 모르는 위치 ${requestFailure.rowCount}개(모드·반복 합계)가 경로 오류다(판정기 성능에서 빠진다).`
    + ' 토큰(AWS_BEARER_TOKEN_BEDROCK) 만료·네트워크를 확인하고 같은 명령을 다시 돌린다(실패한 호출만 다시 묻는다).'];
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
    '### 경로 오류',
    '',
    PATH_ERROR_RULE_TEXT,
    '',
    ...pathErrorList.map((line) => `- ${line}`),
  ].join('\n');
}

// gpu 백엔드면 GPU 모델로 판정하고, GPU 가 실패한 호출만 Bedrock(judgeModelId)이 답한다. 옛 결과(이름표 없음)는 Bedrock 모델만 적는다.
function formatJudgeModel(runInfo) {
  const label = runInfo.judgeModelLabel || runInfo.judgeModelId;
  return label.startsWith('gpu:')
    ? `GPU ${label.slice('gpu:'.length)} (실패하면 Bedrock ${runInfo.judgeModelId})` : label;
}

// 실제로 답한 경로별 호출 수. GPU 판정 결과에 Bedrock 답이 섞였으면 모델이 섞인 결과라 따로 알린다.
function buildJudgeSourceLine(runInfo) {
  const countMap = runInfo.judgeSourceCountMap;
  if (!countMap || !Object.keys(countMap).length) return [];
  const countText = Object.entries(countMap).map(([source, count]) => `${source} ${count}`).join(' · ');
  const isMixed = String(runInfo.judgeModelLabel || '').startsWith('gpu:') && countMap.bedrock > 0;
  return [`- 판정 경로별 호출 ${countText}${isMixed ? ' — 주의: GPU 가 실패한 호출은 Bedrock 이 판정해 모델이 섞였다' : ''}`];
}

// production 트리거의 한국어 분석기. Kiwi 모델이 없으면 production 처럼 대체 규칙으로 잡으므로 결과가 실제 제품과 다르다.
function buildProductionTriggerLine(runInfo) {
  if (!runInfo.productionKoreanAnalyzer) return [];
  return [runInfo.productionKoreanAnalyzer === KOREAN_TRIGGER_ANALYZER_MAP.rule
    ? '- **주의: production 트리거가 한국어를 대체 규칙으로 잡았다**(Kiwi 모델 없음 — `npm run setup:kiwi`). 설치본 제품은 Kiwi 로 잡으므로 시스템 성능이 다를 수 있다'
    : '- production 트리거(main speech-trigger.js) 한국어 Kiwi 형태소 분석 · 영어 규칙'];
}

export function buildDetectionReport({ runInfo, modeMetricsList }) {
  return [
    '# 3.1 탐지 평가 결과',
    '',
    `- 실행: ${runInfo.startedAt} · 입력 ${runInfo.inputPath}`,
    `- 채점 위치 ${runInfo.progress.scoredCount}개 · 라벨 안 붙은 위치(null) ${runInfo.progress.nullCount}개 · 라벨 파일에 없는 새 후보 ${runInfo.progress.newCandidateCount}개`,
    `- 판정 모델 ${formatJudgeModel(runInfo)} · 라우터 경로 ${runInfo.routerMode} · 척도 생성 ${runInfo.isScaleEnabled ? '켜짐(기본)' : '꺼짐'}`,
    ...buildJudgeSourceLine(runInfo),
    `- 한국어 말주머니 매처 ${runInfo.matcherKind}${runInfo.matcherVersion ? ` ${runInfo.matcherVersion}` : ''}`
      + `${runInfo.isApproximate ? ' — 근사(어절 경계 정규식)' : ''} · 영어는 단어 경계 대조`,
    ...buildProductionTriggerLine(runInfo),
    `- 모드 ${runInfo.modeList.join(', ')} · 반복 ${runInfo.repeatCount}회 · 동시 호출 ${runInfo.concurrency} · 캐시 ${runInfo.cacheDir || '끔'}`,
    `- 맥락 창(${runInfo.contextPreset}) ${runInfo.modeList.map((mode) => `${mode} ${formatContextWindow(runInfo.contextWindowMap[mode])}`).join(' / ')}`,
    ...(runInfo.contextPreset === 'production'
      ? ['- 알려진 차이: 실회의 균형 모드는 look-ahead 2.5초 + 보류 2.5초만 기다려, 뒤 맥락 7초 창에 실제로 모이는 ASR 은 약 5초 분량이다.']
      : []),
    `- 기준 커밋 HEAD ${runInfo.git.head || '?'} · production ${runInfo.git.productionMergeBase || '?'}`,
    ...buildRequestFailLine(runInfo.requestFailure),
    '',
    '판정 뒤 단계는 우회했다(생성·전달 단계의 걸러냄이라 판정 성능이 아니다):',
    ...BYPASSED_STAGE_LIST.map((stage) => `- ${stage}`),
    '',
    '알려진 production 차이(측정만 한다):',
    ...KNOWN_PRODUCTION_GAP_LIST.map((gap) => `- ${gap}`),
    '',
    '한계: production 은 1.5~2.5초 ASR 조각마다 트리거를 보고 4초 안에 다시 발동하지 않지만, 이 도구는 문장 단위로 트리거를 보고 문장마다 판단 LLM 을 부른다.'
      + ' 맥락 창은 같은 함수(TranscriptWindow)로 만들지만 조각 경계 효과는 재현하지 않는다.'
      + ' 시각이 없는 전사는 어절(영어는 단어)당 0.45초로 추정한다. 판정 모델은 temperature 0 으로 부르지만 같은 입력에도 답이 달라질 수 있어 --repeat 로 분산을 본다.',
    '',
    ...modeMetricsList.map((modeMetrics) => buildModeSection(modeMetrics)),
    '',
  ].join('\n');
}
