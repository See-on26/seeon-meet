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
  createJudgeRunner, resolveLexicalVerdict, classifyRouterPathError, classifySilencePathError,
  isRouterTextWellFormed, PATH_ERROR_MAP,
  hashProductionSource, PRODUCTION_SOURCE_FILE_LIST_MAP, PRODUCTION_SOURCE_HASH_MAP, buildJudgeModelLabel, countJudgeSource,
} from '../tools/eval/lib/judge-runner.mjs';
import { buildScorePlan, evaluateScorePlan, SYSTEM_MISS_REASON_MAP } from '../tools/eval/lib/score-rows.mjs';
import { REGEX_MATCHER } from '../tools/eval/lib/methodology-matcher.mjs';
import { resolveContextWindow } from '../tools/eval/lib/router-context.mjs';

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

test('라우터 파싱 실패는 production 이 통과로 처리해도 경로 오류로 센다', () => {
  const routed = { candidateList: [{ type: 'deixis', subKind: null, reference: null, anchor: '' }], blockedReason: null, source: 'bedrock' };
  assert.equal(classifyRouterPathError({ routed, capture: { rawText: '판단하기 어렵습니다' } }), PATH_ERROR_MAP.parse);
  assert.equal(classifyRouterPathError({ routed, capture: { rawText: '' } }), PATH_ERROR_MAP.emptyText);
  assert.equal(classifyRouterPathError({ routed: { ...routed, source: 'error' }, capture: { rawText: '' } }), PATH_ERROR_MAP.http);
  assert.equal(classifyRouterPathError({ routed: { ...routed, source: 'fallback' }, capture: { rawText: null } }), PATH_ERROR_MAP.noToken);
  assert.equal(classifyRouterPathError({ routed, capture: { rawText: '{"candidateList":[{"type":"deixis","subKind":"simple"}]}' } }), null);
  assert.equal(isRouterTextWellFormed('{"candidateList":[],"blockedReason":"spoken"}'), true);
  assert.equal(isRouterTextWellFormed('{"candidateList":[]}'), false);
});

test('무발화 판정기는 HTTP 오류와 cue 없는 응답을 경로 오류로 센다', () => {
  assert.equal(classifySilencePathError({ judged: { source: 'error' }, capture: {} }), PATH_ERROR_MAP.http);
  assert.equal(classifySilencePathError({ judged: { source: 'bedrock' }, capture: { rawText: '모르겠다' } }), PATH_ERROR_MAP.parse);
  assert.equal(classifySilencePathError({ judged: { source: 'bedrock' }, capture: { rawText: '{"cue":false,"reason":"end"}' } }), null);
  assert.equal(classifySilencePathError({ judged: { source: 'empty' }, capture: null }), null);
});

test('유형에 맞는 라우터 후보가 있으면 넘김이고 척도는 기본 설정에서 생성 대상이 아니다', () => {
  const routed = {
    candidateList: [
      { type: 'deixis', subKind: 'simple', anchor: '이 부분' },
      { type: 'visual_description', subKind: 'scale', anchor: '길죠' },
    ],
    blockedReason: null,
  };
  const demonstrative = resolveLexicalVerdict({ type: 'demonstrative', routed, isScaleEnabled: false });
  assert.equal(demonstrative.isJudgePass, true);
  assert.equal(demonstrative.isGeneratable, true);
  assert.equal(demonstrative.isArbiterSelected, true);
  assert.deepEqual(demonstrative.anchorList, ['이 부분']);
  const scale = resolveLexicalVerdict({ type: 'scale', routed, isScaleEnabled: false });
  assert.equal(scale.isJudgePass, true);
  assert.equal(scale.isGeneratable, false);
  assert.equal(resolveLexicalVerdict({ type: 'scale', routed, isScaleEnabled: true }).isGeneratable, true);
  const value = resolveLexicalVerdict({ type: 'value', routed: { candidateList: [{ type: 'interpretation', subKind: 'claim_to_value' }] }, isScaleEnabled: false });
  assert.equal(value.isJudgePass, false);
  assert.equal(value.isTypeOnlyMatch, true);
  assert.equal(value.blockReason, 'type_mismatch:interpretation/claim_to_value');
  const blocked = resolveLexicalVerdict({ type: 'adjective_noun', routed: { candidateList: [], blockedReason: 'spoken' }, isScaleEnabled: false });
  assert.equal(blocked.blockReason, 'spoken');
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
      const { text, routed } = routeImpl(input);
      await recorder.fetch('https://bedrock.example/router', { text });
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
  const goodText = '{"candidateList":[{"type":"deixis","subKind":"simple","anchor":"이 부분"}]}';
  let isBroken = true;
  const { runner, callLog } = createFakeRunner({
    routeImpl: () => (isBroken
      ? { text: '음', routed: { candidateList: [{ type: 'deixis' }], blockedReason: null, source: 'bedrock' } }
      : { text: goodText, routed: { candidateList: [{ type: 'deixis', subKind: 'simple', anchor: '이 부분' }], blockedReason: null, source: 'bedrock' } }),
    judgeImpl: () => ({ text: '{}', judged: { hasCue: false, reason: null, source: 'bedrock' } }),
  });
  const input = { utterance: '이 부분이요', before: '', after: '' };
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
    transcript: '이 부분에서 오류가 꽤 길죠.',
    positionList: [
      { posId: 'demonstrative@0-4', type: 'demonstrative', start: 0, end: 4, trigger: '이 부분', sourceList: ['production', 'methodology'], isGap: true, rationale: '대상 없음' },
      { posId: 'scale@14-16', type: 'scale', start: 14, end: 16, trigger: '길죠', sourceList: ['methodology'], isGap: true, rationale: '정도 없음' },
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

test('라벨 위치를 지금 후보와 대조해 출처를 다시 정하고 null 라벨은 진행률로만 센다', () => {
  const plan = buildScorePlan({ itemList: labeledItemList, matcher: REGEX_MATCHER });
  assert.deepEqual(plan.positionList.map((position) => [position.posId, position.sourceList, position.utteranceIndex]), [
    ['demonstrative@0-4', ['production', 'methodology'], 0],
    ['scale@14-16', ['methodology'], 0],
    ['silence@16-24', ['production', 'methodology'], 1],
  ]);
  assert.equal(plan.progress.nullCount, 1);
});

test('같은 발화의 후보는 라우터 호출 1번을 나눠 쓰고 놓친 이유를 나눈다', async () => {
  const plan = buildScorePlan({ itemList: labeledItemList, matcher: REGEX_MATCHER });
  const { runner, callLog } = createFakeRunner({
    routeImpl: () => ({
      text: '{"candidateList":[{"type":"deixis","subKind":"simple","anchor":"이 부분"},{"type":"visual_description","subKind":"scale","anchor":"길죠"}]}',
      routed: {
        candidateList: [{ type: 'deixis', subKind: 'simple', anchor: '이 부분' }, { type: 'visual_description', subKind: 'scale', anchor: '길죠' }],
        blockedReason: null, source: 'bedrock',
      },
    }),
    judgeImpl: () => ({ text: '{"cue":true,"reason":"보라고 함"}', judged: { hasCue: true, reason: '보라고 함', source: 'bedrock' } }),
  });
  const { rowList, rawList } = await evaluateScorePlan({
    plan, mode: 'delayed', contextWindow: resolveContextWindow({ mode: 'delayed' }), repeatIndex: 0, runner, concurrency: 2, isScaleEnabled: false,
  });
  assert.equal(callLog.route, 1);
  assert.equal(callLog.judge, 1);
  assert.equal(rawList.length, 2);
  const rowMap = new Map(rowList.map((row) => [row.posId, row]));
  assert.equal(rowMap.get('demonstrative@0-4').isSystemPass, true);
  assert.equal(rowMap.get('demonstrative@0-4').isAnchorOverlap, true);
  assert.equal(rowMap.get('scale@14-16').isJudgePass, true);
  assert.equal(rowMap.get('scale@14-16').isSystemPass, false);
  assert.equal(rowMap.get('scale@14-16').systemMissReason, SYSTEM_MISS_REASON_MAP.triggerMiss);
  assert.equal(rowMap.get('silence@16-24').isSystemPass, true);
  assert.equal(rowMap.get('silence@16-24').context.transcript, '여러분, 이 사진을 보시죠.');
  assert.ok(rowList.every((row) => row.language === 'ko'));
});

test('production 라우터·무발화 판정기가 실패를 통과·차단으로 덮어도 기록한 원문으로 경로 오류를 가른다', async (t) => {
  t.mock.method(console, 'error', () => {});
  const require = createRequire(import.meta.url);
  const { createUnifiedRouter } = require('../src/main/caption-pipeline/router/unified-router.js');
  const { createSilenceJudge } = require('../src/main/caption-pipeline/router/silence-judge.js');
  const textBody = (content, stopReason = 'end_turn') => JSON.stringify({ output: { message: { content } }, stopReason, usage: null });
  const responseMap = {
    http: () => new Response('{"message":"throttled"}', { status: 429 }),
    network: () => { throw new TypeError('fetch failed'); },
    unparsable: () => new Response(textBody([{ text: '판단하기 어렵습니다' }]), { status: 200 }),
    maxTokensEmpty: () => new Response(textBody([{ reasoningContent: { reasoningText: { text: '...' } } }], 'max_tokens'), { status: 200 }),
    maxTokensCut: () => new Response(textBody([{ text: '{"candidateList":[{"type":"deixis","subKind":"sim' }], 'max_tokens'), { status: 200 }),
    routerOk: () => new Response(textBody([{ text: '{"candidateList":[{"type":"deixis","subKind":"simple","anchor":"이 부분"}]}' }]), { status: 200 }),
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
  const routerInput = { utterance: '이 부분이요', before: '', after: '' };
  const silenceInput = { transcript: '이 사진을 보시죠.', silenceMs: 5000, precondition: { isReady: true, reason: null } };

  const noTokenRunner = createRunner({ ...config, bedrockApiKey: '' });
  const noTokenRouted = await noTokenRunner.runRouter({ input: routerInput, repeatIndex: 0 });
  assert.equal(noTokenRouted.pathError, PATH_ERROR_MAP.noToken);
  assert.equal(noTokenRouted.routed.candidateList[0].type, 'deixis', 'production 은 토큰이 없어도 지시 통과로 돌려준다');
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
    assert.deepEqual(output.routed.candidateList.map((candidate) => candidate.type), ['deixis'], `라우터 ${key} 는 지시 통과로 덮인다`);
    assert.doesNotMatch(JSON.stringify(output), /tok-secret/);
  }
  responseKey = 'maxTokensCut';
  assert.equal((await runner.runRouter({ input: routerInput, repeatIndex: 0 })).capture.stopReason, 'max_tokens');
  responseKey = 'routerOk';
  assert.equal((await runner.runRouter({ input: routerInput, repeatIndex: 0 })).pathError, null);

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
    'src/main/caption-pipeline/prompts/silence-judge.js',
  ]) {
    assert.ok(fileList.includes(filePath), `${filePath} 가 캐시 키에 든다`);
  }
  assert.match(PRODUCTION_SOURCE_HASH_MAP.router, /^[0-9a-f]{64}$/);
  assert.match(PRODUCTION_SOURCE_HASH_MAP.silence, /^[0-9a-f]{64}$/);

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cache-'));
  const callLog = { route: 0, judge: 0 };
  const createRunner = (sourceHashMap) => createJudgeRunner({
    route: async () => {
      callLog.route += 1;
      return { candidateList: [{ type: 'deixis', subKind: 'simple', anchor: '이 부분' }], blockedReason: null, source: 'bedrock' };
    },
    judgeSilence: async () => {
      callLog.judge += 1;
      return { hasCue: false, reason: 'end', source: 'bedrock' };
    },
    capture: async (run) => {
      const result = await run();
      const text = result.candidateList
        ? '{"candidateList":[{"type":"deixis","subKind":"simple","anchor":"이 부분"}]}' : '{"cue":false,"reason":"end"}';
      return { result, captureList: [{ status: 200, bodyText: converseBody(text), elapsedMs: 1, errorMessage: null }] };
    },
    cache: createCacheStore({ cacheDir }),
    routerModelId: 'model-x',
    sourceHashMap,
  });
  const routerInput = { utterance: '이 부분이요', before: '', after: '' };
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
  assert.equal(buildJudgeModelLabel({ config: { judgeBackend: 'gpu', judgeGpuModel: 'qwen3.5-35b-a3b', judgeModelId: 'anthropic.claude-sonnet-5' } }),
    'gpu:qwen3.5-35b-a3b');
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
