import { createRequire } from 'node:module';
import { CONDITION_LIST } from './e2e-material.mjs';

const require = createRequire(import.meta.url);
const { formatMediaClock } = require('../../../src/main/lab/export/clock-format.js');

const formatPercent = (value) => (value === null || value === undefined ? '–' : `${(value * 100).toFixed(1)}%`);
const formatRatio = (value) => (value === null || value === undefined ? '–' : value.toFixed(3));
const formatSpread = ({ mean, std }, format) => (mean === null ? '–' : `${format(mean)}${std === null ? '' : ` ± ${format(std)}`}`);
const formatKb = (byteCount) => `${(byteCount / 1000).toFixed(1)}KB`;
const formatFlag = (value) => (value === null || value === undefined ? '모름' : value ? '예' : '아니오');
const escapeCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const COUNT_LEGEND_LINE = '글 답에서 읽음 = 요청한 JSON 이 아니라 답 전체가 번호 꼴이거나 보기 글 그대로인 글 답에서 읽은 수(정답률에 들어간다).'
  + ' 응답 오류 = 답 번호를 못 읽었거나 요청이 실패한 수(정답률 분모에서 뺀다).';

function buildConditionTable(conditionMap, conditionList = CONDITION_LIST) {
  const lineList = [
    '| 조건 | 답한 문항 | 정답 | 알 수 없음 | 응답 오류 | 그중 요청 실패 | 글 답에서 읽음 | 정답률 CA | 알 수 없음 비율 |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const condition of conditionList) {
    const summary = conditionMap[condition];
    lineList.push(`| ${condition} | ${summary.answeredCount} | ${summary.correctCount} | ${summary.unknownCount} | ${summary.errorCount}`
      + ` | ${summary.requestFailCount} | ${summary.textAnswerCount} | ${formatPercent(summary.ca)} | ${formatPercent(summary.unknownRatio)} |`);
  }
  return lineList.join('\n');
}

function buildGroupTable(groupMap) {
  const lineList = ['| 묶음 | CA A | CA S | CA H | CA C | 도달률 S÷C | 증가폭 (S−A)÷C | AR (S−A)÷(H−A) |', '|---|---|---|---|---|---|---|---|'];
  for (const [groupKey, metric] of Object.entries(groupMap)) {
    const ca = (condition) => formatPercent(metric.conditionMap[condition].ca);
    lineList.push(`| ${escapeCell(groupKey)} | ${ca('A')} | ${ca('S')} | ${ca('H')} | ${ca('C')} | ${formatRatio(metric.reachRate)}`
      + ` | ${formatRatio(metric.reachGain)} | ${formatRatio(metric.accuracyRatio)} |`);
  }
  return lineList.join('\n');
}

function buildGitLine(git) {
  if (!git) return [];
  return [`- 기준 커밋: HEAD ${git.head ?? '모름'} · production merge-base ${git.productionMergeBase ?? '모름'}`
    + `${git.isDirty ? ' (작업 트리에 커밋 안 한 변경 있음)' : ''}`];
}

// 결과 폴더(L2)가 영상 끝까지 돈 완전한 실행인지. 잘린 실행이면 전사 뒤의 사람 작성 AD 를 H 조건만 받는다.
function buildRunStatusSection(runStatusMap = {}) {
  const entryList = Object.entries(runStatusMap);
  if (!entryList.length) return ['## 결과 폴더 상태', '', '- 읽은 결과 폴더가 없다', ''];
  const lineList = [
    '## 결과 폴더 상태',
    '',
    '| 영상 | 결과 폴더 | 실행 모드 | 영상 끝까지 | 결과물 완료 | 전사 끝 | 사람 AD (전사 뒤) | 주의 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const [videoId, status] of entryList) {
    const transcriptEnd = status.transcriptEndMs === null ? '–' : formatMediaClock(status.transcriptEndMs);
    const videoLength = status.videoDurationMs ? ` / ${formatMediaClock(status.videoDurationMs)}` : '';
    lineList.push(`| ${escapeCell(videoId)} | ${escapeCell(status.runDir)} | ${escapeCell(status.mode ?? '모름')}`
      + ` | ${formatFlag(status.isVideoEnded)} | ${formatFlag(status.isComplete)} | ${transcriptEnd}${videoLength}`
      + ` | ${status.humanAdCount} (${status.humanAdAfterTranscriptCount ?? '–'}) | ${escapeCell(status.warningList.join(' / ') || '–')} |`);
  }
  return [...lineList, ''];
}

// 화면 조건(C·V)에 슬라이드를 몇 장 보냈는지와 Bedrock 한도 때문에 줄인 이유.
function buildScreenMaterialSection(screenMaterialList = []) {
  if (!screenMaterialList.length) return [];
  return [
    '## 화면 자료 (슬라이드 이미지)',
    '',
    '| 영상 | 조건 | 있는 슬라이드 | 보낸 슬라이드 | 자료 크기 | 메모 |',
    '|---|---|---|---|---|---|',
    ...screenMaterialList.map((item) => `| ${escapeCell(item.videoId)} | ${item.condition} | ${item.availableSlideCount}장`
      + ` | ${item.sentSlideCount}장${item.sentSlideLabelList.length ? ` (${item.sentSlideLabelList.join(', ')})` : ''}`
      + ` | ${formatKb(item.materialBytes)} | ${escapeCell(item.noteList.join(' / ') || '–')} |`),
    '',
  ];
}

function buildSkippedLineList(skippedList) {
  const groupMap = Map.groupBy(skippedList, (skipped) => `${skipped.condition}:${skipped.reason}`);
  if (!groupMap.size) return ['- 없음'];
  return [...groupMap].map(([key, groupList]) => {
    const videoText = [...new Set(groupList.map((skipped) => skipped.videoId))].join(', ');
    const detailText = [...new Set(groupList.map((skipped) => skipped.detail).filter(Boolean))].join(' / ');
    return `- ${key}: ${groupList.length}건 (영상 ${videoText})${detailText ? ` — ${detailText}` : ''}`;
  });
}

export function buildE2eReport({ runInfo, metrics, repeatSummary, skippedList, screenMaterialList = [] }) {
  const { overall } = metrics;
  return [
    '# 3.2 E2E 이해도 평가 결과',
    '',
    `- 실행: ${runInfo.startedAt} · 문항 셋 ${runInfo.questionPath} (문항 ${runInfo.questionCount}개, 영상 ${runInfo.videoCount}개)`,
    `- 답변 모델 ${runInfo.modelId} · 문항 생성 모델 ${runInfo.generatorModel}${runInfo.isSameModelWarning ? ' — 주의: 같은 모델이다' : ''}`,
    `- 조건 ${runInfo.conditionList.join(', ')} · 반복 ${runInfo.repeatCount}회 · 동시 호출 ${runInfo.concurrency} · 슬라이드 최대 ${runInfo.maxSlideCount}장 · 캐시 ${runInfo.cacheDir || '끔'}`,
    `- 결과 폴더: ${Object.entries(runInfo.runDirMap).map(([videoId, runDir]) => `${videoId}=${runDir}`).join(', ') || '없음'}`,
    ...buildGitLine(runInfo.git),
    '',
    '"알 수 없음"은 오답으로 셌다. 응답 오류(답 번호를 못 읽음)는 정답률 분모에서 빼고 따로 셌다.',
    'C 조건 한계: LLM 은 영상을 볼 수 없어 슬라이드 대표 이미지로 "화면"을 대신했다. 슬라이드가 아닌 화면(영상·판서)은 이미지가 부족할 수 있다.',
    '전사 한계: GPU ASR 서버가 언어를 한국어로 고정한다(tools/gpu-server/asr_server.py language="ko"). 영어 영상의 A·S·H·C 전사는 그 영향을 받는다.',
    '',
    ...buildRunStatusSection(runInfo.runStatusMap),
    '## 전체',
    '',
    buildConditionTable(overall.conditionMap),
    '',
    COUNT_LEGEND_LINE,
    '',
    `- 도달률 S÷C: ${formatRatio(overall.reachRate)}`,
    `- 도달률 증가폭 (S−A)÷C: ${formatRatio(overall.reachGain)}`,
    `- Accuracy Ratio (S−A)÷(H−A): ${formatRatio(overall.accuracyRatio)} (사람 작성 AD 가 있는 문항끼리)`,
    ...(repeatSummary.repeatCount > 1 ? [
      '',
      `반복 ${repeatSummary.repeatCount}회 평균 ± 표본 표준편차: ${CONDITION_LIST.map((condition) => `CA ${condition} ${formatSpread(repeatSummary.caMap[condition], formatPercent)}`).join(' · ')}`
        + ` · 증가폭 ${formatSpread(repeatSummary.reachGain, formatRatio)}`,
    ] : []),
    '',
    '## 도메인 × 조각/통합 × 소분류',
    '',
    buildGroupTable(metrics.byGroup),
    '',
    '## 도메인별',
    '',
    buildGroupTable(metrics.byDomain),
    '',
    '## 언어별',
    '',
    buildGroupTable(metrics.byLanguage),
    '',
    '## 조각/통합별',
    '',
    buildGroupTable(metrics.byCategory),
    '',
    '## 소분류별',
    '',
    buildGroupTable(metrics.bySubcategory),
    '',
    ...buildScreenMaterialSection(screenMaterialList),
    '## 건너뛴 조합',
    '',
    ...buildSkippedLineList(skippedList),
    '',
  ].join('\n');
}

export function buildFilterReport({ runInfo, decisionList, filterSummaryMap = null, screenMaterialList = [] }) {
  const discardedList = decisionList.filter((decision) => decision.decision === 'discard');
  return [
    '# 3.2 문항 필터 결과',
    '',
    `- 실행: ${runInfo.startedAt} · 문항 셋 ${runInfo.questionPath} · 필터 ${runInfo.filterList.join(', ')} · 답변 모델 ${runInfo.modelId}`,
    ...buildGitLine(runInfo.git),
    '- 필터 단계는 "제공된 자료만" 지시 없이 물었다.',
    `- 유지 ${decisionList.length - discardedList.length}개 · 폐기 ${discardedList.length}개`,
    '',
    ...buildRunStatusSection(runInfo.runStatusMap),
    ...(filterSummaryMap ? [
      '## 필터별 답',
      '',
      buildConditionTable(filterSummaryMap, runInfo.filterList),
      '',
      COUNT_LEGEND_LINE,
      '',
    ] : []),
    '## 문항별 결정',
    '',
    '| 문항 | 결정 | 이유 |',
    '|---|---|---|',
    ...decisionList.map((decision) => `| ${escapeCell(decision.questionId)} | ${decision.decision === 'discard' ? '폐기' : '유지'}`
      + ` | ${escapeCell(decision.reasonList.join(' / ') || '–')} |`),
    '',
    ...buildScreenMaterialSection(screenMaterialList),
  ].join('\n');
}
