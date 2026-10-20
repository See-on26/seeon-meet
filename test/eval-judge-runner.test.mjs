import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createFetchRecorder, summarizeConverseCapture } from '../tools/eval/lib/fetch-recorder.mjs';
import { createCacheStore, hashInput } from '../tools/eval/lib/cache-store.mjs';
import { mapWithConcurrency } from '../tools/eval/lib/concurrency.mjs';
import {
  createJudgeRunner, resolveCandidateVerdict, classifyRouterPathError, classifySilencePathError,
  isRouterTextWellFormed, countJudgeableCandidate, PATH_ERROR_MAP, JUDGE_BLOCK_REASON_MAP,
  hashProductionSource, PRODUCTION_SOURCE_FILE_LIST_MAP, PRODUCTION_SOURCE_HASH_MAP, buildJudgeModelLabel, countJudgeSource,
} from '../tools/eval/lib/judge-runner.mjs';
import { buildScorePlan, evaluateScorePlan, SYSTEM_MISS_REASON_MAP, ROUTER_CALL_ROLE_MAP } from '../tools/eval/lib/score-rows.mjs';
import { REGEX_MATCHER } from '../tools/eval/lib/methodology-matcher.mjs';
import { RULE_PRODUCTION_TRIGGER } from '../tools/eval/lib/production-trigger.mjs';
import { resolveContextWindow } from '../tools/eval/lib/router-context.mjs';

const require = createRequire(import.meta.url);
const { parseJudgeText, toNarrationCandidateList } = require('../src/main/caption-pipeline/router/unified-router.js');
const { JUDGE_GROUP_MAP, readJudgeGroup } = require('../src/main/caption-pipeline/prompts/unified-router.js');

// production 라우터가 판단 JSON 을 읽어 돌려주는 꼴을 그대로 만든다. verdictMap: 후보 id → 'O'·'X'.
// production 처럼 묶음(지시 대상·발화 기반)마다 따로 부른 응답(textList, 묶음 안 번호 1~n)도 만든다.
function buildRouted({ candidateList, verdictMap, source = 'gpu' }) {
  const numberedList = candidateList.map((candidate, index) => ({ ...candidate, id: index + 1 }));
  const toAnswer = (list, toId) => JSON.stringify({
    judgeList: list.map((candidate, index) => ({ id: toId(candidate, index), gap: verdictMap[candidate.id] || 'X', reason: `판단 ${candidate.id}` })),
  });
  const text = toAnswer(numberedList, (candidate) => candidate.id);
  const textList = Object.values(JUDGE_GROUP_MAP)
    .map((group) => numberedList.filter((candidate) => readJudgeGroup(candidate.type) === group))
    .filter((list) => list.length)
    .map((list) => toAnswer(list, (_candidate, index) => index + 1));
  const judgeList = parseJudgeText({ text, candidateList: numberedList });
  const narrationList = toNarrationCandidateList(judgeList);
  return { text, textList, routed: { candidateList: narrationList, judgeList, source, blockedReason: narrationList.length ? null : 'no_gap' } };
}

const converseBody = (text) => JSON.stringify({
  output: { message: { content: [{ text }] } }, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 },
});

test('fetch 기록기는 감싼 호출의 원문 응답만 모으고 헤더는 남기지 않는다', async () => {
  const recorder = createFetchRecorder({ baseFetch: async () => new Response(converseBody('{"candidateList":[]}'), { status: 200 }) });
  const { result, captureList } = await recorder.capture(async () => {
    const response = await recorder.fetch('https://bedrock.example/model/x/converse', { headers: { Authorization: 'Bearer secret' } });
    return response.json();
  });
  assert.equal(result.stopReason, 'end_turn', '감싼 쪽도 응답 본문을 그대로 읽는다');
  assert.equal(captureList.length, 1);
  assert.doesNotMatch(JSON.stringify(captureList), /secret/);
  assert.deepEqual(summarizeConverseCapture(captureList), {
    status: 200, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 },
    rawText: '{"candidateList":[]}', errorMessage: null, elapsedMs: captureList[0].elapsedMs,
  });
  await recorder.fetch('https://bedrock.example/other');
  assert.equal(captureList.length, 1, 'capture 밖 호출은 기록하지 않는다');
});

test('판단 응답을 읽지 못하면 production 이 X(해설 안 함)로 처리해도 경로 오류로 센다', () => {
  const candidateList = [{ type: 'demonstrative', phrase: '이 부분', start: 0, end: 4 }];
  const { routed } = buildRouted({ candidateList, verdictMap: {} });
  const classify = (patch, rawText) => classifyRouterPathError({ routed: { ...routed, ...patch }, capture: { rawText }, candidateList });
  assert.equal(classify({}, '판단하기 어렵습니다'), PATH_ERROR_MAP.parse);
  assert.equal(classify({}, ''), PATH_ERROR_MAP.emptyText);
  assert.equal(classify({ source: 'error' }, ''), PATH_ERROR_MAP.http);
  assert.equal(classify({ source: 'fallback' }, null), PATH_ERROR_MAP.noToken);
  assert.equal(classify({}, '{"judgeList":[{"id":1,"gap":"X","reason":"앞에서 밝힘"}]}'), null);
  assert.equal(classify({}, '{"judgeList":[]}'), PATH_ERROR_MAP.parse, '판단이 빠진 후보는 production 이 "판단 없음" X 로 채운다');
  assert.equal(isRouterTextWellFormed({ text: '```json\n{"judgeList":[{"id":1,"gap":"o"},{"id":2,"gap":"X"}]}\n```', candidateCount: 2 }), true);
  assert.equal(isRouterTextWellFormed({ text: '{"judgeList":[{"id":1,"gap":"모름"}]}', candidateCount: 1 }), false);
  assert.equal(isRouterTextWellFormed({ text: '{"candidateList":[]}', candidateCount: 0 }), false, '옛 라우터 꼴은 읽지 않는다');
  assert.equal(countJudgeableCandidate([
    { type: 'demonstrative', phrase: '이 부분' }, { type: 'number', phrase: '' }, { type: 'pointing', phrase: '여기' },
  ]), 1, 'production 은 구가 없거나 모르는 유형인 후보를 넘기지 않는다');
});

// production 판단은 지시 대상·발화 기반 묶음마다 따로 부른다(QA 2-7). 묶음마다 자기 후보 수만큼 번호 1~n 을 읽을 수 있어야 한다.
test('두 묶음을 따로 부른 판단은 호출마다 그 묶음 후보 수로 응답 꼴을 본다', () => {
  const candidateList = [
    { type: 'demonstrative', phrase: '여기', start: 0, end: 2 },
    { type: 'number', phrase: '30%', start: 3, end: 6 },
    { type: 'change', phrase: '많이 올랐습니다', start: 8, end: 15 },
  ];
  const { routed } = buildRouted({ candidateList, verdictMap: {} });
  const deixisText = '{"judgeList":[{"id":1,"reason":"없다","evidence":"","gap":"O"}]}';
  const speechText = '{"judgeList":[{"id":1,"reason":"없다","evidence":"","gap":"O"},{"id":2,"reason":"없다","evidence":"","gap":"X"}]}';
  const classify = (rawTextList) => classifyRouterPathError({
    routed, capture: { rawText: rawTextList.at(-1) }, captureList: rawTextList.map((rawText) => ({ rawText })), candidateList,
  });
  assert.equal(classify([deixisText, speechText]), null);
  assert.equal(classify([speechText, deixisText]), null, '먼저 끝난 호출이 앞에 기록될 수 있다');
  assert.equal(classify([deixisText, '판단하기 어렵습니다']), PATH_ERROR_MAP.parse);
  assert.equal(classify([deixisText, '']), PATH_ERROR_MAP.emptyText);
  assert.equal(classify([deixisText]), PATH_ERROR_MAP.parse, '부른 묶음 수와 기록된 호출 수가 다르면 응답을 다 읽은 것이 아니다');
});

test('판단 프롬프트 해시는 두 묶음 지시문·예시를 모두 담는다', async () => {
  const { PROMPT_HASH_MAP } = await import('../tools/eval/lib/judge-runner.mjs');
  const { ROUTER_PROMPT_MAP } = require('../src/main/caption-pipeline/prompts/unified-router.js');
  const { hashInput } = await import('../tools/eval/lib/cache-store.mjs');
  assert.equal(PROMPT_HASH_MAP.router, hashInput({ promptMap: ROUTER_PROMPT_MAP }));
});

test('무발화 판정기는 HTTP 오류와 cue 없는 응답을 경로 오류로 센다', () => {
  assert.equal(classifySilencePathError({ judged: { source: 'error' }, capture: {} }), PATH_ERROR_MAP.http);
  assert.equal(classifySilencePathError({ judged: { source: 'bedrock' }, capture: { rawText: '모르겠다' } }), PATH_ERROR_MAP.parse);
  assert.equal(classifySilencePathError({ judged: { source: 'bedrock' }, capture: { rawText: '{"cue":false,"reason":"end"}' } }), null);
  assert.equal(classifySilencePathError({ judged: { source: 'empty' }, capture: null }), null);
});

test('위치마다 같은 유형·겹치는 후보의 O/X 를 읽고, 생성 대상·중재 선택은 production 후보 선택기로 본다', () => {
  const { routed } = buildRouted({
    candidateList: [
      { type: 'demonstrative', phrase: '이 부분', start: 0, end: 4 },
      { type: 'scale', phrase: '꽤 길죠', start: 11, end: 15 },
      { type: 'number', phrase: '30%', start: 20, end: 23 },
    ],
    verdictMap: { 1: 'O', 2: 'O', 3: 'X' },
  });
  const pieceStart = 100;
  const verdict = (position, isScaleEnabled = true) => resolveCandidateVerdict({ position, pieceStart, routed, isScaleEnabled });
  const demonstrative = { type: 'demonstrative', start: 100, end: 104 };
  const scale = { type: 'scale', start: 113, end: 115 };
  assert.deepEqual(
    [verdict(demonstrative).isJudgePass, verdict(demonstrative).isGeneratable, verdict(demonstrative).isArbiterSelected],
    [true, true, false], '척도가 켜져 있으면 중재가 지시를 척도에 합쳐 척도를 고른다',
  );
  assert.deepEqual([verdict(scale).isJudgePass, verdict(scale).isGeneratable, verdict(scale).isArbiterSelected], [true, true, true]);
  assert.deepEqual([verdict(scale, false).isJudgePass, verdict(scale, false).isGeneratable], [true, false], '척도를 끄면 생성 대상이 아니다');
  assert.equal(verdict(demonstrative, false).isArbiterSelected, true);
  const value = verdict({ type: 'value', start: 120, end: 123 });
  assert.deepEqual([value.isJudgePass, value.blockReason, value.rationale], [false, JUDGE_BLOCK_REASON_MAP.noGap, '판단 3']);
  assert.equal(verdict({ type: 'change', start: 104, end: 108 }).blockReason, JUDGE_BLOCK_REASON_MAP.notJudged, '넘긴 후보에 없던 위치');
  assert.equal(verdict({ type: 'value', start: 100, end: 104 }).blockReason, JUDGE_BLOCK_REASON_MAP.notJudged, '유형이 다르면 겹쳐도 그 위치의 판단이 아니다');
  assert.match(verdict(demonstrative).judgeText, /지시대명사:"이 부분"=O\(판단 1\) · 추상적 척도:"꽤 길죠"=O\(판단 2\) · 단순 수치:"30%"=X\(판단 3\)/);
});

test('동시 호출 수를 넘지 않고 결과 순서를 지킨다', async () => {
  let runningCount = 0;
  let maxRunningCount = 0;
  const resultList = await mapWithConcurrency({
    itemList: [1, 2, 3, 4, 5], concurrency: 2,
    run: async (value) => {
      runningCount += 1;
      maxRunningCount = Math.max(maxRunningCount, runningCount);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      runningCount -= 1;
      return value * 10;
    },
  });
  assert.deepEqual(resultList, [10, 20, 30, 40, 50]);
  assert.equal(maxRunningCount, 2);
});

function createFakeRunner({ routeImpl, judgeImpl }) {
  const callLog = { route: 0, judge: 0 };
  const recorder = createFetchRecorder({ baseFetch: async (_url, init) => new Response(converseBody(init.text), { status: 200 }) });
  const runner = createJudgeRunner({
    route: async (input) => {
      callLog.route += 1;
      const { text, textList, routed } = routeImpl(input);
      for (const answerText of textList || [text]) await recorder.fetch('https://bedrock.example/router', { text: answerText });
      return routed;
    },
    judgeSilence: async (input) => {
      callLog.judge += 1;
      const { text, judged } = judgeImpl(input);
      await recorder.fetch('https://bedrock.example/silence', { text });
      return judged;
    },
    capture: recorder.capture,
    cache: createCacheStore({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cache-')) }),
    routerModelId: 'model-x',
  });
  return { runner, callLog };
}

test('판정 결과는 입력 해시로 캐시하고 경로 오류는 캐시하지 않는다', async () => {
  let isBroken = true;
  const { runner, callLog } = createFakeRunner({
    routeImpl: (input) => {
      const good = buildRouted({ candidateList: input.candidateList, verdictMap: { 1: 'O' } });
      return isBroken ? { text: '음', routed: buildRouted({ candidateList: input.candidateList, verdictMap: {} }).routed } : good;
    },
    judgeImpl: () => ({ text: '{}', judged: { hasCue: false, reason: null, source: 'bedrock' } }),
  });
  const input = { utterance: '이 부분이요', before: '', after: '', candidateList: [{ type: 'demonstrative', phrase: '이 부분', start: 0, end: 4 }] };
  assert.equal((await runner.runRouter({ input, repeatIndex: 0 })).pathError, PATH_ERROR_MAP.parse);
  isBroken = false;
  const fresh = await runner.runRouter({ input, repeatIndex: 0 });
  assert.equal(fresh.pathError, null);
  assert.equal(fresh.isCacheHit, false);
  assert.equal((await runner.runRouter({ input, repeatIndex: 0 })).isCacheHit, true);
  assert.equal((await runner.runRouter({ input, repeatIndex: 1 })).isCacheHit, false, '반복 번호가 다르면 다시 묻는다');
  assert.equal(callLog.route, 3);
  assert.notEqual(hashInput({ a: 1 }), hashInput({ a: 2 }));
});

test('무발화 전제 조건이 안 맞으면 판정기를 부르지 않는다', async () => {
  const { runner, callLog } = createFakeRunner({ routeImpl: () => ({}), judgeImpl: () => ({}) });
  const output = await runner.runSilence({ input: { transcript: '', silenceMs: 5000, precondition: { isReady: false, reason: 'no_utterance' } }, repeatIndex: 0 });
  assert.equal(output.skipReason, 'no_utterance');
  assert.equal(callLog.judge, 0);
});

const labeledItemList = [
  {
    id: 'd-1', language: 'ko', targetType: 'demonstrative',
    transcript: '이 부분은 평균 40분이에요. 대기 시간이 꽤 길죠.',
    positionList: [
      { posId: 'demonstrative@0-4', type: 'demonstrative', start: 0, end: 4, trigger: '이 부분', sourceList: ['production', 'methodology'], isGap: true, rationale: '대상 없음' },
      { posId: 'value@9-12', type: 'value', start: 9, end: 12, trigger: '40분', sourceList: ['methodology'], isGap: true, rationale: '무엇의 값인지 없음' },
      { posId: 'scale@26-28', type: 'scale', start: 26, end: 28, trigger: '길죠', sourceList: ['methodology'], isGap: true, rationale: '정도 없음' },
    ],
  },
  {
    id: 'd-2', language: 'ko', targetType: 'silence',
    transcript: '여러분, 이 사진을 보시죠. [무발화 7초]',
    positionList: [
      { posId: 'demonstrative@5-9', type: 'demonstrative', start: 5, end: 9, trigger: '이 사진', sourceList: ['production'], isGap: null, rationale: '' },
      { posId: 'silence@16-24', type: 'silence', start: 16, end: 24, trigger: '[무발화 7초]', sourceList: ['production', 'methodology'], isGap: true, rationale: '보라고 함' },
    ],
  },
];

const buildRulePlan = () => buildScorePlan({ itemList: labeledItemList, matcher: REGEX_MATCHER, productionTrigger: RULE_PRODUCTION_TRIGGER });

test('라벨 위치를 지금 후보와 대조해 출처·트리거 포함 여부를 다시 정하고 null 라벨은 진행률로만 센다', () => {
  const plan = buildRulePlan();
  assert.deepEqual(plan.positionList.map((position) => [position.posId, position.sourceList, position.isProductionTriggered, position.utteranceIndex]), [
    ['demonstrative@0-4', ['production', 'methodology'], true, 0],
    ['value@9-12', ['methodology'], false, 0],
    ['scale@26-28', ['production', 'methodology'], true, 1],
    ['silence@16-24', ['production', 'methodology'], true, 1],
  ], '척도 "길죠" 는 지금 production 트리거가 잡는 "꽤 길죠" 와 겹친다');
  assert.equal(plan.progress.nullCount, 1);
  assert.deepEqual(plan.productionCandidateListMap.get('d-1#0').map((candidate) => [candidate.triggerType, candidate.phrase, candidate.pieceStart]), [
    ['demonstrative', '이 부분', 0],
  ]);
});

test('production 후보만 넘긴 호출로 시스템 성능을, 말주머니에만 있는 라벨 위치를 더한 호출로 판정기 성능을 낸다', async () => {
  const plan = buildRulePlan();
  const routeInputList = [];
  const { runner, callLog } = createFakeRunner({
    routeImpl: (input) => {
      routeInputList.push(input);
      return buildRouted({ candidateList: input.candidateList, verdictMap: { 1: 'O', 2: 'O' } });
    },
    judgeImpl: () => ({ text: '{"cue":true,"reason":"보라고 함"}', judged: { hasCue: true, reason: '보라고 함', source: 'bedrock' } }),
  });
  const { rowList, rawList } = await evaluateScorePlan({
    plan, mode: 'delayed', contextWindow: resolveContextWindow({ mode: 'delayed' }), repeatIndex: 0, runner, concurrency: 2, isScaleEnabled: false,
  });
  assert.deepEqual(callLog, { route: 3, judge: 1 });
  assert.deepEqual(rawList.map((raw) => [raw.kind, raw.role, raw.utteranceIndex]), [
    ['router', ROUTER_CALL_ROLE_MAP.system, 0], ['router', ROUTER_CALL_ROLE_MAP.judge, 0], ['router', ROUTER_CALL_ROLE_MAP.both, 1], ['silence', null, 1],
  ]);
  const phraseListOf = (role) => rawList.find((raw) => raw.role === role).input.candidateList.map((candidate) => `${candidate.type}:${candidate.phrase}`);
  assert.deepEqual(phraseListOf(ROUTER_CALL_ROLE_MAP.system), ['demonstrative:이 부분'], 'production 이 넘기는 후보 그대로');
  assert.deepEqual(phraseListOf(ROUTER_CALL_ROLE_MAP.judge), ['demonstrative:이 부분', 'number:40분'], '말주머니 위치는 트리거 유형 이름으로 넘긴다');
  assert.equal(routeInputList.find((input) => input.candidateList.length === 2).utterance, '이 부분은 평균 40분이에요.');
  const rowMap = new Map(rowList.map((row) => [row.posId, row]));
  assert.deepEqual([rowMap.get('demonstrative@0-4').isJudgePass, rowMap.get('demonstrative@0-4').isSystemPass], [true, true]);
  assert.deepEqual(
    [rowMap.get('value@9-12').isJudgePass, rowMap.get('value@9-12').isSystemPass, rowMap.get('value@9-12').systemMissReason],
    [true, false, SYSTEM_MISS_REASON_MAP.triggerMiss],
  );
  assert.deepEqual(
    [rowMap.get('scale@26-28').isJudgePass, rowMap.get('scale@26-28').isSystemPass, rowMap.get('scale@26-28').systemMissReason],
    [true, false, SYSTEM_MISS_REASON_MAP.scaleDisabled],
  );
  assert.match(rowMap.get('value@9-12').context.candidateText, /단순 수치:"40분"=O/);
  assert.equal(rowMap.get('silence@16-24').isSystemPass, true);
  assert.equal(rowMap.get('silence@16-24').context.transcript, '여러분, 이 사진을 보시죠.');
  assert.ok(rowList.every((row) => row.language === 'ko'));
});

test('시스템 호출과 판정 호출의 O/X 가 다르면 지표마다 제 호출을 쓰고, 시스템 호출만 실패하면 판정기 성능에는 남는다', async () => {
  const plan = buildRulePlan();
  const runRoute = async ({ routeImpl }) => {
    const { runner } = createFakeRunner({
      routeImpl, judgeImpl: () => ({ text: '{"cue":false,"reason":"end"}', judged: { hasCue: false, reason: 'end', source: 'bedrock' } }),
    });
    const { rowList } = await evaluateScorePlan({
      plan, mode: 'delayed', contextWindow: resolveContextWindow({ mode: 'delayed' }), repeatIndex: 0, runner, concurrency: 1, isScaleEnabled: true,
    });
    return rowList.find((row) => row.posId === 'demonstrative@0-4');
  };
  const disagreed = await runRoute({
    routeImpl: (input) => buildRouted({ candidateList: input.candidateList, verdictMap: input.candidateList.length === 1 ? { 1: 'X' } : { 1: 'O', 2: 'O' } }),
  });
  assert.deepEqual([disagreed.isJudgePass, disagreed.isSystemPass, disagreed.systemMissReason, disagreed.systemJudgeReason],
    [true, false, SYSTEM_MISS_REASON_MAP.judgeBlock, JUDGE_BLOCK_REASON_MAP.noGap]);
  const systemBroken = await runRoute({
    routeImpl: (input) => (input.candidateList.length === 1
      ? { text: '음', routed: buildRouted({ candidateList: input.candidateList, verdictMap: {} }).routed }
      : buildRouted({ candidateList: input.candidateList, verdictMap: { 1: 'O' } })),
  });
  assert.deepEqual([systemBroken.pathError, systemBroken.systemPathError, systemBroken.isJudgePass], [null, PATH_ERROR_MAP.parse, true]);
});

test('production 라우터·무발화 판정기가 실패를 해설 안 함·차단으로 덮어도 기록한 원문으로 경로 오류를 가른다', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { createUnifiedRouter } = require('../src/main/caption-pipeline/router/unified-router.js');
  const { createSilenceJudge } = require('../src/main/caption-pipeline/router/silence-judge.js');
  const textBody = (content, stopReason = 'end_turn') => JSON.stringify({ output: { message: { content } }, stopReason, usage: null });
  const responseMap = {
    http: () => new Response('{"message":"throttled"}', { status: 429 }),
    network: () => { throw new TypeError('fetch failed'); },
    unparsable: () => new Response(textBody([{ text: '판단하기 어렵습니다' }]), { status: 200 }),
    maxTokensEmpty: () => new Response(textBody([{ reasoningContent: { reasoningText: { text: '...' } } }], 'max_tokens'), { status: 200 }),
    maxTokensCut: () => new Response(textBody([{ text: '{"judgeList":[{"id":1,"gap":"O","rea' }], 'max_tokens'), { status: 200 }),
    routerOk: () => new Response(textBody([{ text: '{"judgeList":[{"id":1,"gap":"O","reason":"대상 없음"}]}' }]), { status: 200 }),
    silenceOk: () => new Response(textBody([{ text: '{"cue":false,"reason":"end"}' }]), { status: 200 }),
  };
  let responseKey = null;
  const recorder = createFetchRecorder({ baseFetch: async () => responseMap[responseKey]() });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = recorder.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const config = { bedrockApiKey: 'tok-secret', bedrockRegion: 'us-east-1', judgeModelId: 'anthropic.claude-sonnet-5' };
  const createRunner = (runnerConfig) => createJudgeRunner({
    route: createUnifiedRouter({ config: runnerConfig }).route,
    judgeSilence: createSilenceJudge({ config: runnerConfig }).judge,
    capture: recorder.capture,
    cache: createCacheStore(),
    routerModelId: runnerConfig.judgeModelId,
  });
  const routerInput = {
    utterance: '이 부분이요', before: '', after: '', candidateList: [{ type: 'demonstrative', phrase: '이 부분', start: 0, end: 4 }],
  };
  const silenceInput = { transcript: '이 사진을 보시죠.', silenceMs: 5000, precondition: { isReady: true, reason: null } };
  const isAllX = (routed) => routed.candidateList.length === 0 && routed.judgeList.every((entry) => !entry.isGap);

  const noTokenRunner = createRunner({ ...config, bedrockApiKey: '' });
  const noTokenRouted = await noTokenRunner.runRouter({ input: routerInput, repeatIndex: 0 });
  assert.equal(noTokenRouted.pathError, PATH_ERROR_MAP.noToken);
  assert.equal(isAllX(noTokenRouted.routed), true, 'production 은 판정할 수 없으면 해설하지 않는다(X)');
  assert.equal((await noTokenRunner.runSilence({ input: silenceInput, repeatIndex: 0 })).pathError, PATH_ERROR_MAP.noToken);

  const runner = createRunner(config);
  const routerCaseList = [
    ['http', PATH_ERROR_MAP.http, 'error'],
    ['network', PATH_ERROR_MAP.http, 'error'],
    ['unparsable', PATH_ERROR_MAP.parse, 'bedrock'],
    ['maxTokensEmpty', PATH_ERROR_MAP.emptyText, 'bedrock'],
    ['maxTokensCut', PATH_ERROR_MAP.parse, 'bedrock'],
  ];
  for (const [key, expectedError, expectedSource] of routerCaseList) {
    responseKey = key;
    const output = await runner.runRouter({ input: routerInput, repeatIndex: 0 });
    assert.equal(output.pathError, expectedError, `라우터 ${key}`);
    assert.equal(output.routed.source, expectedSource, `라우터 ${key} source`);
    assert.equal(isAllX(output.routed), true, `라우터 ${key} 는 해설 안 함(X)으로 덮인다`);
    assert.doesNotMatch(JSON.stringify(output), /tok-secret/);
  }
  responseKey = 'maxTokensCut';
  assert.equal((await runner.runRouter({ input: routerInput, repeatIndex: 0 })).capture.stopReason, 'max_tokens');
  responseKey = 'routerOk';
  const okOutput = await runner.runRouter({ input: routerInput, repeatIndex: 0 });
  assert.equal(okOutput.pathError, null);
  assert.deepEqual(okOutput.routed.judgeList.map((entry) => [entry.phrase, entry.isGap, entry.reason]), [['이 부분', true, '대상 없음']]);

  const silenceCaseList = [
    ['http', PATH_ERROR_MAP.http],
    ['network', PATH_ERROR_MAP.http],
    ['unparsable', PATH_ERROR_MAP.parse],
    ['maxTokensEmpty', PATH_ERROR_MAP.emptyText],
    ['silenceOk', null],
  ];
  for (const [key, expectedError] of silenceCaseList) {
    responseKey = key;
    const output = await runner.runSilence({ input: silenceInput, repeatIndex: 0 });
    assert.equal(output.pathError, expectedError, `무발화 ${key}`);
    assert.equal(output.judged.hasCue, false, `무발화 ${key} 는 차단으로 덮인다`);
    assert.doesNotMatch(JSON.stringify(output), /tok-secret/);
  }
});

test('동시에 돌린 호출의 원문은 서로 섞이지 않는다', async () => {
  const recorder = createFetchRecorder({
    baseFetch: async (_url, init) => {
      await new Promise((resolve) => { setTimeout(resolve, init.delayMs); });
      return new Response(converseBody(init.text), { status: 200 });
    },
  });
  const delayList = [15, 1, 10, 5, 0];
  const outputList = await mapWithConcurrency({
    itemList: delayList, concurrency: delayList.length,
    run: (delayMs, index) => recorder.capture(() => recorder.fetch('https://bedrock.example/router', { text: `answer-${index}`, delayMs })),
  });
  assert.deepEqual(outputList.map(({ captureList }) => summarizeConverseCapture(captureList).rawText), delayList.map((_delayMs, index) => `answer-${index}`));
});

test('판정 결과를 만드는 production 코드가 바뀌면 캐시 키가 달라져 다시 묻는다', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-source-'));
  fs.mkdirSync(path.join(repoRoot, 'src'));
  fs.writeFileSync(path.join(repoRoot, 'src/router.js'), 'const MAX_ROUTER_TOKENS = 300;');
  const beforeHash = hashProductionSource({ repoRoot, fileList: ['src/router.js'] });
  fs.writeFileSync(path.join(repoRoot, 'src/router.js'), 'const MAX_ROUTER_TOKENS = 400;');
  assert.notEqual(hashProductionSource({ repoRoot, fileList: ['src/router.js'] }), beforeHash);

  const fileList = Object.values(PRODUCTION_SOURCE_FILE_LIST_MAP).flat();
  for (const filePath of [
    'src/main/caption-pipeline/router/unified-router.js', 'src/main/caption-pipeline/router/silence-judge.js',
    'src/main/caption-pipeline/agents/shared/bedrock-converse.js', 'src/main/caption-pipeline/prompts/unified-router.js',
    'src/main/caption-pipeline/prompts/silence-judge.js', 'src/main/caption-pipeline/trigger/speech-trigger.js',
  ]) {
    assert.ok(fileList.includes(filePath), `${filePath} 가 캐시 키에 든다`);
  }
  assert.match(PRODUCTION_SOURCE_HASH_MAP.router, /^[0-9a-f]{64}$/);
  assert.match(PRODUCTION_SOURCE_HASH_MAP.silence, /^[0-9a-f]{64}$/);

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cache-'));
  const callLog = { route: 0, judge: 0 };
  const routerInput = {
    utterance: '이 부분이요', before: '', after: '', candidateList: [{ type: 'demonstrative', phrase: '이 부분', start: 0, end: 4 }],
  };
  const okRouted = buildRouted({ candidateList: routerInput.candidateList, verdictMap: { 1: 'O' } });
  const createRunner = (sourceHashMap) => createJudgeRunner({
    route: async () => {
      callLog.route += 1;
      return okRouted.routed;
    },
    judgeSilence: async () => {
      callLog.judge += 1;
      return { hasCue: false, reason: 'end', source: 'bedrock' };
    },
    capture: async (run) => {
      const result = await run();
      const text = result.judgeList ? okRouted.text : '{"cue":false,"reason":"end"}';
      return { result, captureList: [{ status: 200, bodyText: converseBody(text), elapsedMs: 1, errorMessage: null }] };
    },
    cache: createCacheStore({ cacheDir }),
    routerModelId: 'model-x',
    sourceHashMap,
  });
  const silenceInput = { transcript: '이 사진을 보시죠.', silenceMs: 5000, precondition: { isReady: true, reason: null } };
  const mergedRunner = createRunner(PRODUCTION_SOURCE_HASH_MAP);
  assert.equal((await mergedRunner.runRouter({ input: routerInput, repeatIndex: 0 })).isCacheHit, false);
  assert.equal((await mergedRunner.runSilence({ input: silenceInput, repeatIndex: 0 })).isCacheHit, false);
  assert.equal((await createRunner(PRODUCTION_SOURCE_HASH_MAP).runRouter({ input: routerInput, repeatIndex: 0 })).isCacheHit, true);
  const changedRunner = createRunner({ router: hashInput('router changed'), silence: hashInput('silence changed') });
  assert.equal((await changedRunner.runRouter({ input: routerInput, repeatIndex: 0 })).isCacheHit, false, '라우터 코드가 바뀌면 다시 묻는다');
  assert.equal((await changedRunner.runSilence({ input: silenceInput, repeatIndex: 0 })).isCacheHit, false, '무발화 판정기 코드가 바뀌면 다시 묻는다');
  assert.deepEqual(callLog, { route: 2, judge: 2 });
});

const chatBody = (content, finishReason = 'stop') => JSON.stringify({
  choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5 },
});

test('GPU LLM(OpenAI chat) 응답 원문에서도 글·종료 사유·사용량을 꺼낸다', () => {
  const summary = summarizeConverseCapture([{ url: 'http://127.0.0.1:8801/v1/chat/completions', status: 200, bodyText: chatBody('{"cue":true}'), elapsedMs: 480, errorMessage: null }]);
  assert.equal(summary.rawText, '{"cue":true}');
  assert.equal(summary.stopReason, 'stop');
  assert.deepEqual(summary.usage, { prompt_tokens: 10, completion_tokens: 5 });
});

test('GPU 가 실패하고 Bedrock 으로 넘어간 판정은 마지막(Bedrock) 응답을 읽는다', () => {
  const summary = summarizeConverseCapture([
    { url: 'http://127.0.0.1:8801/v1/chat/completions', status: null, bodyText: '', elapsedMs: 3, errorMessage: 'fetch failed' },
    { url: 'https://bedrock', status: 200, bodyText: converseBody('{"cue":false}'), elapsedMs: 2100, errorMessage: null },
  ]);
  assert.equal(summary.rawText, '{"cue":false}');
});

test('무발화 판정이 gpu 로 답했으면 bedrock 과 같이 원문 형식을 검사한다', () => {
  const capture = { rawText: '{"cue":true,"reason":"presenting"}' };
  assert.equal(classifySilencePathError({ judged: { source: 'gpu' }, capture }), null);
  assert.equal(classifySilencePathError({ judged: { source: 'gpu' }, capture: { rawText: 'cue=yes' } }), PATH_ERROR_MAP.parse);
  assert.equal(classifySilencePathError({ judged: { source: 'gpu' }, capture: { rawText: '' } }), PATH_ERROR_MAP.emptyText);
});

test('판정 원문 해시에 판정 LLM 경로 모듈(judge-llm.js)과 설정(config.js)이 들어간다', () => {
  for (const fileList of Object.values(PRODUCTION_SOURCE_FILE_LIST_MAP)) {
    assert.ok(fileList.includes('src/main/caption-pipeline/agents/shared/judge-llm.js'));
    assert.ok(fileList.includes('src/main/caption-pipeline/config.js'));
  }
});

test('판정 모델 이름표: gpu 백엔드면 GPU 모델(폴백 Bedrock), bedrock 이면 Bedrock 모델', () => {
  assert.equal(buildJudgeModelLabel({ config: { judgeBackend: 'gpu', judgeGpuModel: 'gemma-4-26b-a4b-qat', judgeModelId: 'anthropic.claude-sonnet-5' } }),
    'gpu:gemma-4-26b-a4b-qat');
  assert.equal(buildJudgeModelLabel({ config: { judgeBackend: 'bedrock', judgeModelId: 'anthropic.claude-sonnet-5' } }), 'anthropic.claude-sonnet-5');
});

test('판정 경로별 호출 수를 센다(gpu·bedrock·그 밖)', () => {
  const rawList = [
    { kind: 'router', output: { source: 'gpu' } }, { kind: 'router', output: { source: 'gpu' } },
    { kind: 'router', output: { source: 'bedrock' } }, { kind: 'silence', output: { source: 'gpu' } },
    { kind: 'silence', output: null, skipReason: 'no_transcript' }, { kind: 'router', output: { source: 'error' } },
  ];
  assert.deepEqual(countJudgeSource({ rawList }), { gpu: 3, bedrock: 1, error: 1 });
});
