import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { validateQuestionSet, formatIssueList, ISSUE_LEVEL_MAP } from './dataset-validate.mjs';
import { readRunMaterial, CONDITION_LIST, FILTER_LIST, DEFAULT_MAX_SLIDE_COUNT } from './e2e-material.mjs';
import { INSTRUCTION_KIND_MAP } from './e2e-prompt.mjs';
import { buildAnswerTaskList, runAnswerTaskList, summarizeFilterDecision, BEDROCK_REQUEST_LIMIT_MAP } from './e2e-runner.mjs';
import { buildE2eMetrics, summarizeRepeatMetric, summarizeConditionMap } from './e2e-metrics.mjs';
import { buildE2eReport, buildFilterReport } from './e2e-report.mjs';
import { buildAnswerCsv } from './answer-csv.mjs';
import { createCacheStore } from './cache-store.mjs';
import { formatRunStamp } from './run-stamp.mjs';
import { loadRepoEnv, assertBedrockToken, REPO_ROOT } from './bedrock-env.mjs';

const require = createRequire(import.meta.url);
const { readPipelineConfig } = require('../../../src/main/caption-pipeline/config.js');
const { requestConverseText } = require('../../../src/main/caption-pipeline/agents/shared/bedrock-converse.js');
const { readGitInfo } = require('../../../src/main/lab/git-info.js');
const { EVAL_PRESET_MODE } = require('../../../src/main/lab/lab-mode.js');
const { formatMediaClock } = require('../../../src/main/lab/export/clock-format.js');

export const E2E_USAGE = 'node tools/eval/e2e-eval.mjs --questions questions.json [--run <videoId>=<결과 폴더>]...'
  + ' [--condition A,S,H,C | --filter N,V,C] [--model 모델ID] [--repeat N] [--concurrency 4] [--max-slides 20]'
  + ' [--cache 폴더 | --no-cache] [--out-dir 폴더]';

const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, 'out', 'eval', 'cache', 'e2e');
// Sonnet 5 는 JSON 앞에 숨은 추론으로 토큰을 쓴다. 상한이 작으면 답이 잘려 응답 오류가 된다.
const ANSWER_MAX_TOKENS = 1000;
const ANSWER_TIMEOUT_MS = 60000;
const PROGRESS_LOG_EVERY = 20;
const POSITIVE_INTEGER_TEXT_PATTERN = /^[1-9]\d*$/;

const normalizeModelId = (modelId) => String(modelId || '').toLowerCase()
  .replace(/^(?:us|eu|apac|global)\./, '').replace(/^anthropic\./, '');

// 문항 생성 모델과 답변 모델은 달라야 한다(회의록 3.2.3).
export function isSameModel({ generatorModel, modelId }) {
  const generator = normalizeModelId(generatorModel);
  const answer = normalizeModelId(modelId);
  return Boolean(generator) && Boolean(answer) && (generator === answer || answer.startsWith(generator) || generator.startsWith(answer));
}

function parseListOption(text, allowedList, name) {
  const valueList = String(text).split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
  const unknownList = valueList.filter((value) => !allowedList.includes(value));
  if (!valueList.length || unknownList.length) throw new Error(`${name} 는 ${allowedList.join(',')} 중에서 고른다 (지금: ${text})`);
  return [...new Set(valueList)];
}

function parseRunOptionList(runOptionList) {
  const runDirMap = {};
  for (const option of runOptionList) {
    const separatorIndex = option.indexOf('=');
    if (separatorIndex <= 0) throw new Error(`--run 은 <videoId>=<결과 폴더> 꼴이다 (지금: ${option})`);
    runDirMap[option.slice(0, separatorIndex)] = option.slice(separatorIndex + 1);
  }
  return runDirMap;
}

// 반복·동시 호출·슬라이드 수는 1 이상의 정수다. 2.5 같은 값은 반복 횟수와 보고서 표기가 어긋난다.
function readPositiveInteger(text, name) {
  const value = POSITIVE_INTEGER_TEXT_PATTERN.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value)) throw new Error(`${name} 는 1 이상의 정수여야 한다 (지금: ${JSON.stringify(text)})`);
  return value;
}

// 옵션은 토큰 확인·Bedrock 호출 전에 모두 확인한다.
function resolveE2eOption(values) {
  const isFilterMode = Boolean(values.filter);
  return {
    isFilterMode,
    kindList: isFilterMode
      ? parseListOption(values.filter, FILTER_LIST, '--filter')
      : parseListOption(values.condition, CONDITION_LIST, '--condition'),
    runDirMap: parseRunOptionList(values.run),
    repeatCount: readPositiveInteger(values.repeat, '--repeat'),
    concurrency: readPositiveInteger(values.concurrency, '--concurrency'),
    maxSlideCount: readPositiveInteger(values['max-slides'], '--max-slides'),
    cacheDir: values['no-cache'] ? null : values.cache,
  };
}

function readRunJson(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
}

// 결과 폴더가 영상 끝까지 돈 완전한 실행인지 본다. 잘린 실행에서는 전사가 일찍 끝나
// 그 뒤의 사람 작성 AD 를 H 조건만 받으므로 몇 개인지 함께 남긴다.
function readRunStatus({ runDir, material, video }) {
  const runJson = readRunJson(runDir);
  const endMsList = (material.utteranceList || [])
    .map((utterance) => Number(utterance.endMs ?? utterance.startMs)).filter(Number.isFinite);
  const transcriptEndMs = endMsList.length ? Math.max(...endMsList) : null;
  const humanAdList = video.humanAdList || [];
  const humanAdAfterTranscriptCount = humanAdList.filter((ad) => transcriptEndMs === null || ad.startMs > transcriptEndMs).length;
  const isComplete = typeof runJson?.isComplete === 'boolean' ? runJson.isComplete : null;
  const isVideoEnded = runJson && Object.hasOwn(runJson, 'videoEndedWallMs') ? runJson.videoEndedWallMs !== null : null;
  const mode = typeof runJson?.mode === 'string' ? runJson.mode : null;
  const videoDurationMs = Number.isFinite(runJson?.videoDurationMs) ? runJson.videoDurationMs : null;
  const warningList = [];
  if (!runJson) warningList.push('run.json 을 읽지 못해 실행이 영상 끝까지 갔는지 모른다');
  if (isComplete === false) warningList.push('결과물에 빠진 것이 있다 (run.json isComplete=false)');
  if (isVideoEnded === false) {
    warningList.push(`영상 끝까지 가지 않았다 — 전사가 ${transcriptEndMs === null ? '–' : formatMediaClock(transcriptEndMs)} 에서 끝난다`
      + `${videoDurationMs ? ` (영상 ${formatMediaClock(videoDurationMs)})` : ''}`);
  }
  if (isVideoEnded !== true && humanAdAfterTranscriptCount > 0) {
    warningList.push(`사람 작성 AD ${humanAdAfterTranscriptCount}개가 전사 끝 뒤에 있어 H 조건만 그 구간 자료를 받는다`);
  }
  if (mode && mode !== EVAL_PRESET_MODE) warningList.push(`실행 모드 ${mode} — 팀 기준은 균형 모드(${EVAL_PRESET_MODE})`);
  return {
    runDir, mode, isComplete, isVideoEnded, videoDurationMs, transcriptEndMs,
    humanAdCount: humanAdList.length, humanAdAfterTranscriptCount, warningList,
  };
}

// 영상마다 결과 폴더를 읽는다. 못 읽은 영상은 멈추지 않고 이유를 남겨 그 영상의 조건만 건너뛴다.
function loadMaterialMap({ questionSet, runDirMap, log }) {
  const materialMap = new Map();
  const materialErrorMap = new Map();
  const resolvedRunDirMap = {};
  const runStatusMap = {};
  const videoIdSet = new Set(questionSet.videoList.map((video) => video.videoId));
  for (const videoId of Object.keys(runDirMap)) {
    if (!videoIdSet.has(videoId)) log(`[e2e] 주의: --run 의 ${videoId} 는 문항 셋 videoList 에 없어 쓰지 않는다`);
  }
  for (const video of questionSet.videoList) {
    const runDir = runDirMap[video.videoId] || video.runDir;
    if (!runDir) continue;
    const absoluteRunDir = path.resolve(runDir);
    resolvedRunDirMap[video.videoId] = absoluteRunDir;
    let material = null;
    try {
      material = readRunMaterial({ runDir: absoluteRunDir });
    } catch (error) {
      log(`[e2e] ${video.videoId} 결과 폴더를 읽지 못했다 (${absoluteRunDir}): ${error.message}`);
      materialErrorMap.set(video.videoId, error.message);
      runStatusMap[video.videoId] = {
        runDir: absoluteRunDir, mode: null, isComplete: null, isVideoEnded: null, videoDurationMs: null, transcriptEndMs: null,
        humanAdCount: (video.humanAdList || []).length, humanAdAfterTranscriptCount: null,
        warningList: [`결과 폴더를 읽지 못해 이 영상의 조건을 건너뛰었다 — ${error.message}`],
      };
      continue;
    }
    materialMap.set(video.videoId, material);
    runStatusMap[video.videoId] = readRunStatus({ runDir: absoluteRunDir, material, video });
    for (const warning of runStatusMap[video.videoId].warningList) log(`[e2e] 주의: ${video.videoId} ${warning}`);
  }
  return { materialMap, materialErrorMap, resolvedRunDirMap, runStatusMap };
}

function logConditionSummary({ log, summaryMap }) {
  for (const [condition, summary] of Object.entries(summaryMap)) {
    log(`[e2e] ${condition}: 답 ${summary.answeredCount} · 정답 ${summary.correctCount} · 알 수 없음 ${summary.unknownCount}`
      + ` · 글 답에서 읽음 ${summary.textAnswerCount} · 응답 오류 ${summary.errorCount}(요청 실패 ${summary.requestFailCount})`);
  }
}

const toJsonl = (rowList) => rowList.map((row) => JSON.stringify(row)).join('\n') + (rowList.length ? '\n' : '');

export async function runE2eCommand({
  argList, log = console.log, env = process.env, requestAnswer = null, now = () => new Date(), readGit = readGitInfo,
}) {
  let values = null;
  try {
    ({ values } = parseArgs({
      args: argList,
      options: {
        questions: { type: 'string' },
        run: { type: 'string', multiple: true, default: [] },
        condition: { type: 'string', default: CONDITION_LIST.join(',') },
        filter: { type: 'string' },
        model: { type: 'string' },
        repeat: { type: 'string', default: '1' },
        concurrency: { type: 'string', default: '4' },
        'max-slides': { type: 'string', default: String(DEFAULT_MAX_SLIDE_COUNT) },
        cache: { type: 'string', default: DEFAULT_CACHE_DIR },
        'no-cache': { type: 'boolean', default: false },
        'out-dir': { type: 'string' },
      },
    }));
  } catch (error) {
    log(`[e2e] ${error.message}\n사용법: ${E2E_USAGE}`);
    return 2;
  }
  if (!values.questions) {
    log(`사용법: ${E2E_USAGE}`);
    return 2;
  }
  let option = null;
  try {
    option = resolveE2eOption(values);
  } catch (error) {
    log(`[e2e] ${error.message}\n사용법: ${E2E_USAGE}`);
    return 2;
  }
  const { isFilterMode, kindList, runDirMap, concurrency, maxSlideCount, cacheDir } = option;
  const repeatCount = isFilterMode ? 1 : option.repeatCount;
  if (env === process.env) loadRepoEnv();
  try {
    assertBedrockToken({ env });
  } catch (error) {
    log(`[e2e] ${error.message}`);
    return 1;
  }
  let questionText = '';
  try {
    questionText = fs.readFileSync(values.questions, 'utf8');
  } catch (error) {
    log(`[e2e] 문항 셋을 읽지 못했다: ${error.message}`);
    return 1;
  }
  const { questionSet, issueList } = validateQuestionSet({ text: questionText });
  const errorList = issueList.filter((issue) => issue.level === ISSUE_LEVEL_MAP.error);
  if (errorList.length) {
    log(`[e2e] 문항 셋 형식 오류 ${errorList.length}건\n${formatIssueList(errorList)}`);
    return 1;
  }

  const config = readPipelineConfig(env);
  const modelId = values.model || config.bedrockModelId;
  const isSameModelWarning = isSameModel({ generatorModel: questionSet.generatorModel, modelId });
  if (isSameModelWarning) log(`[e2e] 주의: 답변 모델(${modelId})이 문항 생성 모델(${questionSet.generatorModel})과 같다`);
  // 인증·URL·inferenceConfig 는 production Bedrock 호출을 그대로 쓴다.
  const answer = requestAnswer || ((request) => requestConverseText({
    config, modelId: request.modelId, systemPrompt: request.systemPrompt, messageList: request.messageList,
    maxTokens: ANSWER_MAX_TOKENS, timeoutMs: ANSWER_TIMEOUT_MS, label: 'e2e 답변',
  }));
  const { materialMap, materialErrorMap, resolvedRunDirMap, runStatusMap } = loadMaterialMap({ questionSet, runDirMap, log });
  const { taskList, skippedList, screenMaterialList } = buildAnswerTaskList({
    questionSet, materialMap, materialErrorMap, kindList, repeatCount, maxSlideCount,
    instructionKind: isFilterMode ? INSTRUCTION_KIND_MAP.filter : INSTRUCTION_KIND_MAP.eval,
  });
  for (const item of screenMaterialList) {
    for (const note of item.noteList) log(`[e2e] 화면 자료 ${item.videoId} ${item.condition}: ${note}`);
  }
  const startedAt = now();
  log(`[e2e] ${isFilterMode ? '필터' : '평가'} 시작 — 호출 ${taskList.length}회 · 건너뜀 ${skippedList.length}건 · 모델 ${modelId}`);
  const answerList = await runAnswerTaskList({
    taskList, requestAnswer: answer, cache: createCacheStore({ cacheDir }), modelId, concurrency,
    onProgress: ({ doneCount, totalCount }) => {
      if (doneCount % PROGRESS_LOG_EVERY === 0 && doneCount < totalCount) log(`[e2e] 진행 ${doneCount}/${totalCount}`);
    },
  });

  const stamp = formatRunStamp(startedAt);
  const outDir = values['out-dir'] || path.join(REPO_ROOT, 'out', 'eval', `${isFilterMode ? 'e2e-filter' : 'e2e'}-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  const runInfo = {
    startedAt: startedAt.toISOString(), questionPath: path.resolve(values.questions), modelId,
    generatorModel: questionSet.generatorModel, isSameModelWarning, repeatCount, concurrency, maxSlideCount, cacheDir,
    answerMaxTokens: ANSWER_MAX_TOKENS, requestLimitMap: BEDROCK_REQUEST_LIMIT_MAP,
    runDirMap: resolvedRunDirMap, runStatusMap, questionCount: questionSet.questionList.length, videoCount: questionSet.videoList.length,
    cacheHitCount: answerList.filter((item) => item.isCacheHit).length,
    ...(isFilterMode ? { filterList: kindList } : { conditionList: kindList }),
    git: await readGit(),
  };
  const summaryMap = summarizeConditionMap({ answerList, conditionList: kindList });
  fs.writeFileSync(path.join(outDir, 'answers.jsonl'), toJsonl(answerList));
  if (isFilterMode) {
    const decisionList = summarizeFilterDecision({ questionSet, answerList, skippedList });
    fs.writeFileSync(path.join(outDir, 'filter.json'), `${JSON.stringify({
      runInfo, decisionList, filterSummaryMap: summaryMap, skippedList, screenMaterialList,
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'report.md'), buildFilterReport({
      runInfo, decisionList, filterSummaryMap: summaryMap, screenMaterialList,
    }));
  } else {
    const metrics = buildE2eMetrics({ answerList });
    const repeatSummary = summarizeRepeatMetric({ answerList });
    fs.writeFileSync(path.join(outDir, 'answers.csv'), buildAnswerCsv({ answerList, modelId }));
    fs.writeFileSync(path.join(outDir, 'metrics.json'), `${JSON.stringify({
      runInfo, metrics, repeatSummary, skippedList, screenMaterialList,
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'report.md'), buildE2eReport({ runInfo, metrics, repeatSummary, skippedList, screenMaterialList }));
  }
  logConditionSummary({ log, summaryMap });
  const requestFailCount = answerList.filter((item) => item.isResponseError && item.errorMessage).length;
  if (requestFailCount) {
    log(`[e2e] 주의: 요청 실패 ${requestFailCount}건 — 실패한 답은 캐시에 넣지 않으므로 같은 명령을 다시 돌리면 그것만 다시 묻는다`);
  }
  log(`[e2e] 결과 → ${outDir}`);
  return 0;
}
