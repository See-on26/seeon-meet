import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeConfusion, buildMetricTable, summarizeRepeat, summarizeMissReason, buildModeMetrics, listErrorCase, countPathError, METRIC_KIND_MAP,
} from '../tools/eval/lib/detection-metrics.mjs';
import { buildDetectionReport } from '../tools/eval/lib/detection-report.mjs';
import { runScoreCommand } from '../tools/eval/lib/score-command.mjs';
import { formatRunStamp } from '../tools/eval/lib/run-stamp.mjs';
import { REGEX_MATCHER } from '../tools/eval/lib/methodology-matcher.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readGitInfo } = require('../src/main/lab/git-info.js');

const row = (patch) => ({
  itemId: 'd', language: 'ko', posId: 'p', type: 'demonstrative', mode: 'realtime_mix', repeatIndex: 0, pathError: null,
  truthIsGap: true, isJudgePass: true, isSystemPass: true, judgeReason: null, systemMissReason: null, ...patch,
});

test('혼동 행렬과 정밀도·재현율·F1, 분모가 0 이면 null', () => {
  const confusion = computeConfusion({
    predictKey: 'isJudgePass',
    rowList: [
      row({ truthIsGap: true, isJudgePass: true }), row({ truthIsGap: true, isJudgePass: false }),
      row({ truthIsGap: false, isJudgePass: true }), row({ truthIsGap: false, isJudgePass: false }),
      row({ truthIsGap: false, isJudgePass: false }),
    ],
  });
  assert.deepEqual(
    { tp: confusion.tp, fp: confusion.fp, fn: confusion.fn, tn: confusion.tn, count: confusion.count },
    { tp: 1, fp: 1, fn: 1, tn: 2, count: 5 },
  );
  assert.equal(confusion.precision, 0.5);
  assert.equal(confusion.recall, 0.5);
  assert.equal(confusion.f1, 0.5);
  assert.equal(confusion.accuracy, 0.6);
  assert.equal(confusion.gapRatio, 0.4);
  const empty = computeConfusion({ rowList: [], predictKey: 'isJudgePass' });
  assert.equal(empty.precision, null);
  assert.equal(empty.f1, null);
});

test('경로 오류 행은 지표에서 빠지고 유형별·전체 표가 나온다', () => {
  const table = buildMetricTable({
    metricKind: METRIC_KIND_MAP.system,
    rowList: [
      row({ type: 'scale', isSystemPass: false, systemMissReason: 'trigger_miss' }),
      row({ type: 'adjective_noun', pathError: 'parse' }),
      row({ type: 'adjective_noun' }),
    ],
  });
  assert.equal(table.all.count, 2);
  assert.equal(table.scale.fn, 1);
  assert.equal(table.adjective_noun.tp, 1);
  assert.equal(table.silence.count, 0);
});

test('FN 을 판정 차단 사유와 시스템 단계로 나눈다', () => {
  const summary = summarizeMissReason({
    rowList: [
      row({ isJudgePass: false, isSystemPass: false, judgeReason: 'spoken', systemMissReason: 'judge_block' }),
      row({ type: 'scale', isJudgePass: true, isSystemPass: false, systemMissReason: 'scale_disabled' }),
      row({ type: 'scale', isJudgePass: true, isSystemPass: false, systemMissReason: 'trigger_miss' }),
      row({ truthIsGap: false, isJudgePass: false, isSystemPass: false }),
    ],
  });
  assert.deepEqual(summary.judgeReasonMap, { spoken: 1 });
  assert.deepEqual(summary.systemReasonMap, { 'judge_block:spoken': 1, scale_disabled: 1, trigger_miss: 1 });
});

test('반복별 지표의 평균과 표본 표준편차를 낸다', () => {
  const summary = summarizeRepeat({
    tableList: [
      buildMetricTable({ metricKind: METRIC_KIND_MAP.judge, rowList: [row({}), row({ isJudgePass: false })] }),
      buildMetricTable({ metricKind: METRIC_KIND_MAP.judge, rowList: [row({}), row({})] }),
    ],
  });
  assert.equal(summary.all.recall.mean, 0.75);
  assert.equal(summary.all.recall.n, 2);
  assert.ok(Math.abs(summary.all.recall.std - Math.SQRT1_2 / 2) < 1e-9);
  assert.equal(summary.silence.recall.mean, null);
});

test('틀린 사례는 지표마다 정답 근거와 판정 근거를 나란히 남긴다', () => {
  const errorList = listErrorCase({
    rowList: [row({ isJudgePass: false, isSystemPass: false, judgeReason: 'spoken', truthRationale: '대상 없음', context: { utterance: 'x' } })],
  });
  assert.deepEqual(errorList.map((error) => [error.metric, error.judgeReason, error.truthRationale]), [
    ['judge', 'spoken', '대상 없음'], ['system', 'spoken', '대상 없음'],
  ]);
});

test('모드 지표는 언어별 표와 언어별 FN 을 함께 낸다', () => {
  const modeMetrics = buildModeMetrics({
    mode: 'delayed',
    rowListByRepeat: [[
      row({}),
      row({ language: 'en', isSystemPass: false, systemMissReason: 'trigger_miss' }),
      row({ language: 'en', isSystemPass: false, systemMissReason: 'trigger_miss' }),
    ]],
  });
  assert.equal(modeMetrics.repeatList[0].byLanguage.ko.system.all.tp, 1);
  assert.equal(modeMetrics.repeatList[0].byLanguage.en.system.all.fn, 2);
  assert.equal(modeMetrics.repeatList[0].byLanguage.en.judge.all.tp, 2);
  assert.deepEqual(modeMetrics.missReason.byLanguage.en.systemReasonMap, { trigger_miss: 2 });
  assert.equal(modeMetrics.summary.byLanguage.en.system.all.recall.mean, 0);
  assert.deepEqual(modeMetrics.languageRowCountMap, { ko: 1, en: 2 });
});

const buildRunInfo = (patch) => ({
  startedAt: '2026-10-05T00:00:00.000Z', inputPath: '/tmp/x.jsonl', progress: { scoredCount: 2, nullCount: 1, newCandidateCount: 0 },
  judgeModelId: 'anthropic.claude-sonnet-5', routerMode: 'unified', isScaleEnabled: false, matcherKind: 'regex', matcherVersion: null,
  isApproximate: true, modeList: ['delayed'], contextPreset: 'production', contextWindowMap: { delayed: { beforeMs: 60000, afterMs: 7000 } },
  repeatCount: 1, concurrency: 4, cacheDir: null, git: { head: 'abc', productionMergeBase: 'def' },
  ...patch,
});

test('보고서에 두 지표 표·언어별 표·FN 나누기·우회 단계·알려진 production 차이가 들어간다', () => {
  const modeMetrics = buildModeMetrics({
    mode: 'delayed',
    rowListByRepeat: [[row({}), row({ type: 'scale', isSystemPass: false, systemMissReason: 'trigger_miss' }), row({ language: 'en', isSystemPass: false, systemMissReason: 'trigger_miss' })]],
  });
  const report = buildDetectionReport({ runInfo: buildRunInfo({}), modeMetricsList: [modeMetrics] });
  assert.match(report, /### 판정기 성능/);
  assert.match(report, /### 시스템 성능/);
  assert.match(report, /\| 3-3 추상적 척도 \| 1 \|/);
  assert.match(report, /trigger_miss: 1/);
  assert.match(report, /무발화 게이트/);
  assert.match(report, /근사\(어절 경계 정규식\)/);
  assert.match(report, /production def/);
  assert.match(report, /#### 한국어/);
  assert.match(report, /#### 영어/);
  assert.match(report, /영어 시스템 성능의 FN\n- trigger_miss: 1/);
  assert.match(report, /production 트리거는 한국어 글자열만 본다/);
  assert.match(report, /맥락 창\(production\) delayed 앞 60초·뒤 7초/);
  assert.match(report, /약 5초 분량/);
});

test('production 트리거가 잡은 위치의 경로 오류는 두 지표의 비율·FN·틀린 사례에서 빠지고 종류·종료 사유별로 따로 센다', () => {
  const pathErrorRow = {
    itemId: 'e', language: 'en', posId: 'q', type: 'value', mode: 'delayed', repeatIndex: 0,
    truthIsGap: true, pathError: 'parse', stopReason: 'max_tokens', isProductionTriggered: true,
  };
  const rowList = [row({ mode: 'delayed' }), pathErrorRow, { ...pathErrorRow, posId: 'r', pathError: 'http', stopReason: null }];
  assert.deepEqual(countPathError({ rowList }), {
    total: 2, byKindMap: { parse: 1, http: 1 }, byStopReasonMap: { max_tokens: 1, 없음: 1 },
  });
  assert.deepEqual(summarizeMissReason({ rowList }), { judgeReasonMap: {}, systemReasonMap: {} });
  assert.deepEqual(listErrorCase({ rowList }), []);
  const modeMetrics = buildModeMetrics({ mode: 'delayed', rowListByRepeat: [rowList] });
  assert.equal(modeMetrics.repeatList[0].judge.all.count, 1);
  assert.equal(modeMetrics.repeatList[0].system.value.count, 0);
  assert.equal(modeMetrics.repeatList[0].pathError.total, 2);
  assert.equal(modeMetrics.languageRowCountMap.en, 2);
  assert.equal(modeMetrics.repeatList[0].byLanguage.en.judge.all.count, 0);
  const report = buildDetectionReport({ runInfo: buildRunInfo({}), modeMetricsList: [modeMetrics] });
  assert.match(report, /#### 영어/, '경로 오류만 있는 언어도 표를 낸다');
  assert.match(report, /- 반복 1: 2건 \(parse 1, http 1 · 종료 사유 max_tokens 1, 없음 1\)/);
});

test('production 트리거가 안 잡은 위치의 경로 오류는 시스템 성능에서 trigger_miss 로 세고 판정기 성능에서는 뺀다', () => {
  const untriggeredRow = {
    itemId: 'u', language: 'en', posId: 'u1', type: 'demonstrative', mode: 'delayed', repeatIndex: 0,
    truthIsGap: true, pathError: 'empty_text', stopReason: 'max_tokens', isProductionTriggered: false,
  };
  const rowList = [
    untriggeredRow,
    { ...untriggeredRow, posId: 'u2', truthIsGap: false },
    { ...untriggeredRow, posId: 't1', isProductionTriggered: true },
  ];
  const pickCount = (confusion) => ({ tp: confusion.tp, fp: confusion.fp, fn: confusion.fn, tn: confusion.tn, count: confusion.count });
  assert.equal(buildMetricTable({ rowList, metricKind: METRIC_KIND_MAP.judge }).all.count, 0, '판정기 결과는 알 수 없으므로 모두 뺀다');
  assert.deepEqual(
    pickCount(buildMetricTable({ rowList, metricKind: METRIC_KIND_MAP.system }).demonstrative),
    { tp: 0, fp: 0, fn: 1, tn: 1, count: 2 },
    '트리거가 잡은 위치(t1)는 시스템 결과도 알 수 없어 뺀다',
  );
  assert.deepEqual(summarizeMissReason({ rowList }), { judgeReasonMap: {}, systemReasonMap: { trigger_miss: 1 } });
  assert.deepEqual(
    listErrorCase({ rowList }).map((error) => [error.metric, error.posId, error.systemMissReason, error.pathError]),
    [['system', 'u1', 'trigger_miss', 'empty_text']],
  );
  const modeMetrics = buildModeMetrics({ mode: 'delayed', rowListByRepeat: [rowList] });
  assert.equal(modeMetrics.repeatList[0].byLanguage.en.system.all.fn, 1);
  assert.equal(modeMetrics.repeatList[0].byLanguage.en.judge.all.count, 0);
  assert.deepEqual(modeMetrics.missReason.byLanguage.en.systemReasonMap, { trigger_miss: 1 });
  assert.equal(modeMetrics.repeatList[0].pathError.total, 3, '경로 오류 개수는 그대로 센다');
});

test('반복마다 분모가 달라 값이 있는 반복이 적은 칸은 (n=k) 를 붙이고 각주와 경로 오류 규칙을 적는다', () => {
  const modeMetrics = buildModeMetrics({
    mode: 'delayed',
    rowListByRepeat: [
      [row({ type: 'scale' }), row({})],
      [row({ type: 'scale', pathError: 'parse', isProductionTriggered: true }), row({})],
    ],
  });
  const report = buildDetectionReport({ runInfo: buildRunInfo({ repeatCount: 2 }), modeMetricsList: [modeMetrics] });
  assert.match(report, /\| 3-3 추상적 척도 \| 1 \| 100\.0% \| 1 \| 0 \| 0 \| 0 \| 100\.0% \(n=1\) \| 100\.0% \(n=1\) \| 100\.0% \(n=1\) \| 100\.0% \(n=1\) \|/);
  assert.match(report, /\| 2-1 지시대명사 \| 1 \| 100\.0% \| 1 \| 0 \| 0 \| 0 \| 100\.0% ± 0\.0 \| 100\.0% ± 0\.0 \|/);
  assert.match(report, /후보·공백 비율·TP·FP·FN·TN 은 반복 1 기준/);
  assert.match(report, /경로 오류로 반복마다 분모가 달라질 수 있어/);
  assert.match(report, /시스템 성능에서는 production 트리거가 잡지 않은 위치만 trigger_miss/);
});

test('결과 폴더 시각 표기는 로컬 YYYYMMDD-HHmmss 다', () => {
  assert.equal(formatRunStamp(new Date(2026, 9, 5, 9, 7, 3)), '20261005-090703');
});

const labeledLine = JSON.stringify({
  id: 'd-1', language: 'ko', domain: '강의', pairId: 'p', targetType: 'demonstrative', resolution: 'none', generatorModel: 'm',
  transcript: '자, 다음으로 넘어가 볼게요. 이 부분에서 오류가 제일 많이 납니다.',
  positionList: [{ posId: 'demonstrative@17-21', type: 'demonstrative', start: 17, end: 21, trigger: '이 부분', sourceList: ['production'], isGap: true, rationale: '대상 없음' }],
});

function prepareInput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-score-'));
  const inFile = path.join(dir, 'labeled.jsonl');
  fs.writeFileSync(inFile, `${labeledLine}\n`);
  return { dir, inFile };
}

test('잘못된 옵션은 토큰 확인보다 먼저 2 로 끝난다', async () => {
  const { inFile } = prepareInput();
  const logList = [];
  assert.equal(await runScoreCommand({ argList: ['--in', inFile, '--context', 'wide'], env: {}, log: (line) => logList.push(line) }), 2);
  assert.equal(await runScoreCommand({ argList: ['--in', inFile, '--before-ms=-1'], env: {}, log: (line) => logList.push(line) }), 2);
  assert.equal(await runScoreCommand({ argList: ['--in', inFile, '--unknown'], env: {}, log: (line) => logList.push(line) }), 2);
  assert.match(logList.join('\n'), /--context/);
});

test('맥락 창 ms·반복·동시 호출·매처 값이 비었거나 숫자가 아니면 기본값으로 바꾸지 않고 2 로 끝난다', async () => {
  const { inFile } = prepareInput();
  const logList = [];
  const badOptionList = [
    ['--before-ms='], ['--after-ms', 'abc'], ['--after-ms', 'Infinity'], ['--before-ms', ' '], ['--before-ms', '0x10'],
    ['--repeat', '0'], ['--repeat', '2.5'], ['--repeat', 'two'], ['--concurrency', ''], ['--matcher', 'kiwii'],
  ];
  for (const optionList of badOptionList) {
    const code = await runScoreCommand({ argList: ['--in', inFile, ...optionList], env: {}, log: (line) => logList.push(line) });
    assert.equal(code, 2, optionList.join(' '));
  }
  const logText = logList.join('\n');
  for (const name of ['--before-ms', '--after-ms', '--repeat', '--concurrency', '--matcher']) assert.match(logText, new RegExp(name));
  assert.equal(
    await runScoreCommand({ argList: ['--in', inFile, '--before-ms', '0', '--after-ms', '1500.5'], env: {}, log: () => {} }),
    1,
    '0 과 소수 ms 는 받아들이고 토큰 확인까지 간다',
  );
});

test('토큰이 없으면 판정기를 부르지 않고 바로 멈춘다', async () => {
  const { inFile } = prepareInput();
  const logList = [];
  let routeCount = 0;
  const code = await runScoreCommand({
    argList: ['--in', inFile], env: {}, log: (line) => logList.push(line),
    createRouter: () => ({ route: async () => { routeCount += 1; return {}; } }),
  });
  assert.equal(code, 1);
  assert.equal(routeCount, 0);
  assert.match(logList.join('\n'), /AWS_BEARER_TOKEN_BEDROCK/);
});

test('score 는 판정을 돌려 report·metrics·errors·raw 를 쓴다', async () => {
  const { dir, inFile } = prepareInput();
  const outDir = path.join(dir, 'out');
  let installedFetch = null;
  const code = await runScoreCommand({
    argList: ['--in', inFile, '--mode', 'all', '--no-cache', '--matcher', 'regex', '--out-dir', outDir],
    env: { AWS_BEARER_TOKEN_BEDROCK: 'token-for-test' },
    log: () => {},
    baseFetch: async () => new Response(JSON.stringify({ output: { message: { content: [{ text: '{"candidateList":[],"blockedReason":"spoken"}' }] } }, stopReason: 'end_turn' })),
    installFetch: (fetchImpl) => { installedFetch = fetchImpl; },
    createRouter: () => ({
      route: async () => {
        await installedFetch('https://bedrock.example/router', {});
        return { candidateList: [], blockedReason: 'spoken', source: 'bedrock' };
      },
    }),
    createJudge: () => ({ judge: async () => ({ hasCue: false, reason: null, source: 'bedrock' }) }),
    createMatcher: async () => REGEX_MATCHER,
    readGit: async () => ({ head: 'abc', productionMergeBase: 'def' }),
  });
  assert.equal(code, 0);
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['errors.jsonl', 'metrics.json', 'raw.jsonl', 'report.md']);
  const metrics = JSON.parse(fs.readFileSync(path.join(outDir, 'metrics.json'), 'utf8'));
  assert.deepEqual(metrics.modeMetricsList.map((modeMetrics) => modeMetrics.mode), ['delayed', 'realtime_mix', 'listening']);
  assert.equal(metrics.modeMetricsList[0].repeatList[0].judge.demonstrative.fn, 1);
  const rawList = fs.readFileSync(path.join(outDir, 'raw.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rawList.length, 3);
  assert.equal(rawList[0].capture.rawText, '{"candidateList":[],"blockedReason":"spoken"}');
  assert.doesNotMatch(fs.readFileSync(path.join(outDir, 'raw.jsonl'), 'utf8'), /token-for-test/);
  const errorList = fs.readFileSync(path.join(outDir, 'errors.jsonl'), 'utf8').trim().split('\n');
  assert.equal(errorList.length, 6, '모드 3개 × 지표 2개');
});

test('판정기 호출이 Bedrock 에 닿지 못하면(http·no_token) 결과는 쓰되 크게 알리고 1 로 끝난다', async () => {
  for (const [source, kind] of [['error', 'http'], ['fallback', 'no_token']]) {
    const { dir, inFile } = prepareInput();
    const outDir = path.join(dir, `out-${kind}`);
    const logList = [];
    let installedFetch = null;
    const code = await runScoreCommand({
      argList: ['--in', inFile, '--no-cache', '--matcher', 'regex', '--repeat', '2', '--out-dir', outDir],
      env: { AWS_BEARER_TOKEN_BEDROCK: 'token-for-test' },
      log: (line) => logList.push(line),
      baseFetch: async () => new Response('{"message":"The security token included in the request is expired"}', { status: 403 }),
      installFetch: (fetchImpl) => { installedFetch = fetchImpl; },
      createRouter: () => ({
        route: async () => {
          if (source === 'error') await installedFetch('https://bedrock.example/router', {});
          return { candidateList: [], blockedReason: null, source };
        },
      }),
      createJudge: () => ({ judge: async () => ({ hasCue: false, reason: null, source: 'bedrock' }) }),
      createMatcher: async () => REGEX_MATCHER,
      readGit: async () => ({ head: 'abc', productionMergeBase: 'def' }),
    });
    assert.equal(code, 1, kind);
    assert.deepEqual(fs.readdirSync(outDir).sort(), ['errors.jsonl', 'metrics.json', 'raw.jsonl', 'report.md']);
    const logText = logList.join('\n');
    assert.match(logText, new RegExp(`\\[score\\] 실패: 판정기 호출 2회가 Bedrock 에 닿지 못했다 \\(${kind} 2\\)`), logText);
    assert.match(logText, /캐시에 넣지 않으므로 같은 명령을 다시 돌리면 그것만 다시 묻는다/);
    assert.match(logList.at(-1), /실패: 판정기 호출/);
    const report = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
    assert.match(report.split('\n').slice(0, 12).join('\n'), /주의: 판정기 호출 2회가 Bedrock 에 닿지 못했다/);
    const { runInfo } = JSON.parse(fs.readFileSync(path.join(outDir, 'metrics.json'), 'utf8'));
    assert.deepEqual(runInfo.requestFailure, { callCount: 2, rowCount: 2, byKindMap: { [kind]: 2 } });
  }
});

test('score 는 기본으로 균형(delayed) 모드·항목 전체 맥락으로 돌리고 --after-ms 로 뒤 창만 바꿀 수 있다', async () => {
  const { dir, inFile } = prepareInput();
  const outDir = path.join(dir, 'out-default');
  let installedFetch = null;
  const routeInputList = [];
  const code = await runScoreCommand({
    argList: ['--in', inFile, '--no-cache', '--matcher', 'regex', '--after-ms', '5000', '--out-dir', outDir],
    env: { AWS_BEARER_TOKEN_BEDROCK: 'token-for-test' },
    log: () => {},
    baseFetch: async () => new Response(JSON.stringify({ output: { message: { content: [{ text: '{"candidateList":[{"type":"deixis","subKind":"simple"}]}' }] } } })),
    installFetch: (fetchImpl) => { installedFetch = fetchImpl; },
    createRouter: () => ({
      route: async (input) => {
        routeInputList.push(input);
        await installedFetch('https://bedrock.example/router', {});
        return { candidateList: [{ type: 'deixis', subKind: 'simple', reference: null, anchor: '' }], blockedReason: null, source: 'bedrock' };
      },
    }),
    createJudge: () => ({ judge: async () => ({ hasCue: false, reason: null, source: 'bedrock' }) }),
    createMatcher: async () => REGEX_MATCHER,
    readGit: async () => ({ head: 'abc', productionMergeBase: 'def' }),
  });
  assert.equal(code, 0);
  const metrics = JSON.parse(fs.readFileSync(path.join(outDir, 'metrics.json'), 'utf8'));
  assert.deepEqual(metrics.runInfo.modeList, ['delayed']);
  assert.deepEqual(metrics.runInfo.contextWindowMap.delayed, { preset: 'item', beforeMs: null, afterMs: 5000, anchorTs: null });
  assert.equal(routeInputList[0].before, '자, 다음으로 넘어가 볼게요.', '항목의 앞 발화가 그대로 들어간다');
  assert.equal(routeInputList[0].after, '');
});

test('git 정보는 HEAD·브랜치·production merge-base·변경 여부이고 git 이 실패하면 null 이다', async () => {
  const answerMap = { 'rev-parse HEAD': 'abc123\n', 'rev-parse --abbrev-ref HEAD': 'experiment\n', 'merge-base HEAD production': 'def456\n', 'status --porcelain': '' };
  const exec = async (_command, argList) => {
    const key = argList.join(' ');
    if (!(key in answerMap)) throw new Error('unknown');
    return { stdout: answerMap[key] };
  };
  assert.deepEqual(await readGitInfo({ cwd: '/repo', exec }), { head: 'abc123', branch: 'experiment', productionMergeBase: 'def456', isDirty: false });
  assert.deepEqual(await readGitInfo({ cwd: '/repo', exec: async () => { throw new Error('no git'); } }), {
    head: null, branch: null, productionMergeBase: null, isDirty: null,
  });
});
