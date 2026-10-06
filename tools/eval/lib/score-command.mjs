import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { validateDetectionItemList, formatIssueList, ISSUE_LEVEL_MAP } from './dataset-validate.mjs';
import { createMethodologyMatcher, MATCHER_KIND_MAP } from './methodology-matcher.mjs';
import { createFetchRecorder } from './fetch-recorder.mjs';
import { createCacheStore } from './cache-store.mjs';
import {
  createJudgeRunner, PATH_ERROR_MAP, buildJudgeModelLabel, countJudgeSource,
} from './judge-runner.mjs';
import { buildScorePlan, evaluateScorePlan } from './score-rows.mjs';
import { buildModeMetrics, listErrorCase } from './detection-metrics.mjs';
import { buildDetectionReport } from './detection-report.mjs';
import { formatRunStamp } from './run-stamp.mjs';
import { loadRepoEnv, assertBedrockToken, REPO_ROOT } from './bedrock-env.mjs';
import { EVAL_MODE_LIST } from './eval-types.mjs';
import { resolveContextWindow, CONTEXT_PRESET_MAP } from './router-context.mjs';

const require = createRequire(import.meta.url);
const { readPipelineConfig } = require('../../../src/main/caption-pipeline/config.js');
const { createUnifiedRouter, ROUTER_MODE_MAP } = require('../../../src/main/caption-pipeline/router/unified-router.js');
const { createSilenceJudge } = require('../../../src/main/caption-pipeline/router/silence-judge.js');
const { readGitInfo } = require('../../../src/main/lab/git-info.js');

export const SCORE_USAGE = 'node tools/eval/detection-eval.mjs score --in labeled.jsonl'
  + ' [--mode delayed|realtime_mix|listening|all] [--context item|symmetric7|production] [--before-ms N] [--after-ms N]'
  + ' [--repeat N] [--concurrency 4] [--cache 폴더 | --no-cache] [--matcher auto|kiwi|regex] [--out-dir 폴더]';

// 팀 결정: 성능 평가는 교차 출력의 균형 모드(delayed, 뒤 맥락 7초)로 한다.
export const DEFAULT_SCORE_MODE = 'delayed';

const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, 'out', 'eval', 'cache', 'detection');

// 소수점까지 허용하는 0 이상의 십진수. 빈 값·공백·16진수·지수·Infinity 는 받지 않는다.
const MS_TEXT_PATTERN = /^\d+(?:\.\d+)?$/;
const POSITIVE_INTEGER_TEXT_PATTERN = /^[1-9]\d*$/;

function resolveModeList(mode) {
  if (mode === 'all') return [...EVAL_MODE_LIST];
  if (!EVAL_MODE_LIST.includes(mode)) throw new Error(`--mode 는 ${EVAL_MODE_LIST.join('|')}|all 중 하나다 (지금: ${mode})`);
  return [mode];
}

// 빈 값(--before-ms=)을 0 으로, 숫자가 아닌 글을 프리셋으로 조용히 바꾸면 다른 맥락 창으로 평가하게 되므로 멈춘다.
function readOptionalMs(text, name) {
  if (text === undefined) return null;
  const value = MS_TEXT_PATTERN.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(value)) throw new Error(`${name} 는 0 이상의 ms 숫자여야 한다 (지금: ${JSON.stringify(text)})`);
  return value;
}

// 반복·동시 호출 수는 1 이상의 정수다. 2.5 같은 값은 반복 횟수와 보고서 표기가 어긋난다.
function readPositiveInteger(text, name) {
  const value = POSITIVE_INTEGER_TEXT_PATTERN.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value)) throw new Error(`${name} 는 1 이상의 정수여야 한다 (지금: ${JSON.stringify(text)})`);
  return value;
}

// 매처 이름을 잘못 쓰면 auto 처럼 동작해 Kiwi·근사 중 무엇으로 돌았는지 헷갈린다.
function readMatcherKind(text) {
  const kindList = Object.values(MATCHER_KIND_MAP);
  if (!kindList.includes(text)) throw new Error(`--matcher 는 ${kindList.join('|')} 중 하나다 (지금: ${JSON.stringify(text)})`);
  return text;
}

// 옵션은 Bedrock 을 부르기 전에 모두 확인한다.
export function resolveScoreOption(values) {
  const modeList = resolveModeList(values.mode);
  const beforeMs = readOptionalMs(values['before-ms'], '--before-ms');
  const afterMs = readOptionalMs(values['after-ms'], '--after-ms');
  return {
    modeList,
    contextWindowMap: Object.fromEntries(modeList.map((mode) => [mode, resolveContextWindow({
      mode, preset: values.context, beforeMs, afterMs,
    })])),
    repeatCount: readPositiveInteger(values.repeat, '--repeat'),
    concurrency: readPositiveInteger(values.concurrency, '--concurrency'),
    cacheDir: values['no-cache'] ? null : values.cache,
    matcherKind: readMatcherKind(values.matcher),
  };
}

const toJsonl = (rowList) => rowList.map((row) => JSON.stringify(row)).join('\n') + (rowList.length ? '\n' : '');

// 판정기 호출이 판정 LLM(GPU·Bedrock)에 닿지 못한 경로 오류. parse·empty_text 는 모델이 낸 응답이라 측정 대상이고, 이 둘은 실행 실패다.
const REQUEST_FAIL_KIND_LIST = [PATH_ERROR_MAP.http, PATH_ERROR_MAP.noToken];

export function summarizeRequestFailure({ rawList, rowList }) {
  const failedCallList = rawList.filter((raw) => REQUEST_FAIL_KIND_LIST.includes(raw.pathError));
  const byKindMap = {};
  for (const raw of failedCallList) byKindMap[raw.pathError] = (byKindMap[raw.pathError] || 0) + 1;
  return {
    callCount: failedCallList.length,
    rowCount: rowList.filter((row) => REQUEST_FAIL_KIND_LIST.includes(row.pathError)).length,
    byKindMap,
  };
}

// 토큰 만료·네트워크 오류면 표는 정상처럼 보여도 그 위치가 빠져 있다. 마지막 줄로 크게 알린다.
function formatRequestFailLine({ requestFailure, totalCallCount }) {
  const kindText = Object.entries(requestFailure.byKindMap).map(([kind, count]) => `${kind} ${count}`).join(' · ');
  return `[score] 실패: 판정기 호출 ${requestFailure.callCount}회가 판정 LLM(GPU·Bedrock)에 닿지 못했다 (${kindText}) — 전체 ${totalCallCount}회 중.`
    + ` 결과 파일은 썼지만 판정 결과를 모르는 위치 ${requestFailure.rowCount}개(모드·반복 합계)가 경로 오류다(판정기 성능에서 빠진다).`
    + ' GPU 서버 연결(터널)·토큰(AWS_BEARER_TOKEN_BEDROCK) 만료·네트워크를 확인한다. 실패한 호출은 캐시에 넣지 않으므로 같은 명령을 다시 돌리면 그것만 다시 묻는다(종료 코드 1).';
}

export async function runScoreCommand({
  argList,
  log = console.log,
  env = process.env,
  installFetch = (fetchImpl) => { globalThis.fetch = fetchImpl; },
  baseFetch = globalThis.fetch.bind(globalThis),
  createRouter = createUnifiedRouter,
  createJudge = createSilenceJudge,
  createMatcher = createMethodologyMatcher,
  readGit = readGitInfo,
  now = () => new Date(),
}) {
  let values = null;
  try {
    ({ values } = parseArgs({
      args: argList,
      options: {
        in: { type: 'string' },
        mode: { type: 'string', default: DEFAULT_SCORE_MODE },
        context: { type: 'string', default: CONTEXT_PRESET_MAP.item },
        'before-ms': { type: 'string' },
        'after-ms': { type: 'string' },
        repeat: { type: 'string', default: '1' },
        concurrency: { type: 'string', default: '4' },
        cache: { type: 'string', default: DEFAULT_CACHE_DIR },
        'no-cache': { type: 'boolean', default: false },
        matcher: { type: 'string', default: MATCHER_KIND_MAP.auto },
        'out-dir': { type: 'string' },
      },
    }));
  } catch (error) {
    log(`[score] ${error.message}\n사용법: ${SCORE_USAGE}`);
    return 2;
  }
  if (!values.in) {
    log(`사용법: ${SCORE_USAGE}`);
    return 2;
  }
  let option = null;
  try {
    option = resolveScoreOption(values);
  } catch (error) {
    log(`[score] ${error.message}\n사용법: ${SCORE_USAGE}`);
    return 2;
  }
  if (env === process.env) loadRepoEnv();
  try {
    assertBedrockToken({ env });
  } catch (error) {
    log(`[score] ${error.message}`);
    return 1;
  }
  const { itemList, issueList } = validateDetectionItemList({ text: fs.readFileSync(values.in, 'utf8'), isLabeledRequired: true });
  const errorList = issueList.filter((issue) => issue.level === ISSUE_LEVEL_MAP.error);
  if (errorList.length) {
    log(`[score] 형식 오류 ${errorList.length}건\n${formatIssueList(errorList)}`);
    return 1;
  }
  const { modeList, contextWindowMap, repeatCount, concurrency, cacheDir, matcherKind } = option;

  const config = readPipelineConfig(env);
  if (config.routerMode !== ROUTER_MODE_MAP.unified) {
    log(`[score] 주의: SEEON_ROUTER_MODE=${config.routerMode} — 이 도구는 통합 라우터 경로만 평가한다`);
  }
  const recorder = createFetchRecorder({ baseFetch });
  installFetch(recorder.fetch);
  const router = createRouter({ config });
  const silenceJudge = createJudge({ config });
  const runner = createJudgeRunner({
    route: (input) => router.route(input),
    judgeSilence: (input) => silenceJudge.judge(input),
    capture: recorder.capture,
    cache: createCacheStore({ cacheDir }),
    routerModelId: buildJudgeModelLabel({ config }),
  });
  const matcher = await createMatcher({ kind: matcherKind });
  const plan = buildScorePlan({ itemList, matcher });
  const startedAt = now();

  const modeMetricsList = [];
  const allRowList = [];
  const allRawList = [];
  for (const mode of modeList) {
    const rowListByRepeat = [];
    for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
      const { rowList, rawList } = await evaluateScorePlan({
        plan, mode, contextWindow: contextWindowMap[mode], repeatIndex, runner, concurrency, isScaleEnabled: config.isScaleEnabled,
      });
      rowListByRepeat.push(rowList);
      allRowList.push(...rowList);
      allRawList.push(...rawList);
      log(`[score] ${mode} 반복 ${repeatIndex + 1}/${repeatCount} — 위치 ${rowList.length}개 · 호출 ${rawList.length}회`
        + ` (캐시 ${rawList.filter((raw) => raw.isCacheHit).length})`);
    }
    modeMetricsList.push(buildModeMetrics({ mode, rowListByRepeat }));
  }

  const outDir = values['out-dir'] || path.join(REPO_ROOT, 'out', 'eval', `detection-${formatRunStamp(startedAt)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const requestFailure = summarizeRequestFailure({ rawList: allRawList, rowList: allRowList });
  const runInfo = {
    startedAt: startedAt.toISOString(),
    inputPath: path.resolve(values.in),
    progress: plan.progress,
    judgeModelId: config.judgeModelId,
    judgeModelLabel: buildJudgeModelLabel({ config }),
    judgeSourceCountMap: countJudgeSource({ rawList: allRawList }),
    routerMode: config.routerMode,
    isScaleEnabled: config.isScaleEnabled,
    matcherKind: matcher.kind,
    matcherVersion: matcher.version,
    isApproximate: matcher.isApproximate,
    modeList,
    contextPreset: values.context,
    contextWindowMap,
    repeatCount,
    concurrency,
    cacheDir,
    requestFailure,
    git: await readGit(),
  };
  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify({ runInfo, modeMetricsList }, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.md'), buildDetectionReport({ runInfo, modeMetricsList }));
  fs.writeFileSync(path.join(outDir, 'errors.jsonl'), toJsonl(listErrorCase({ rowList: allRowList })));
  fs.writeFileSync(path.join(outDir, 'raw.jsonl'), toJsonl(allRawList));
  log(`[score] 결과 → ${outDir}`);
  if (requestFailure.callCount) {
    log(formatRequestFailLine({ requestFailure, totalCallCount: allRawList.length }));
    return 1;
  }
  return 0;
}
