import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRunMaterial } from '../tools/eval/lib/e2e-material.mjs';
import { INSTRUCTION_KIND_MAP } from '../tools/eval/lib/e2e-prompt.mjs';
import { computeDerivedMetric, buildE2eMetrics, summarizeRepeatMetric } from '../tools/eval/lib/e2e-metrics.mjs';
import { buildAnswerCsv, ANSWER_CSV_COLUMN_LIST } from '../tools/eval/lib/answer-csv.mjs';
import { buildE2eReport, buildFilterReport } from '../tools/eval/lib/e2e-report.mjs';
import {
  decideFilter, summarizeFilterDecision, countFilterDecision, buildAnswerTaskList, runAnswerTaskList, TASK_SKIP_REASON_MAP, BEDROCK_REQUEST_LIMIT_MAP,
} from '../tools/eval/lib/e2e-runner.mjs';
import { createCacheStore } from '../tools/eval/lib/cache-store.mjs';
import { runE2eCommand, isSameModel } from '../tools/eval/lib/e2e-command.mjs';

function writeRunDir() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-run-'));
  fs.writeFileSync(path.join(runDir, 'transcript.txt'), '[00:01] 이 부분이요\n[00:05] 30%예요\n');
  fs.writeFileSync(path.join(runDir, 'transcript.json'), JSON.stringify({
    utteranceList: [{ startMs: 1000, endMs: 3000, text: '이 부분이요' }, { startMs: 5000, endMs: 6000, text: '30%예요' }],
  }));
  fs.writeFileSync(path.join(runDir, 's-condition.txt'), '[00:01] 이 부분이요\n[00:03] (화면 해설) 재구매율 막대 30%\n[00:05] 30%예요\n');
  fs.mkdirSync(path.join(runDir, 'slides'));
  fs.writeFileSync(path.join(runDir, 'slides', 'slide-1.jpg'), 'jpg-bytes');
  fs.writeFileSync(path.join(runDir, 'slides.json'), JSON.stringify({ slideList: [{ label: '1', startMediaMs: 0, file: 'slides/slide-1.jpg' }] }));
  return runDir;
}

const question = {
  id: 'q-1', videoId: 'v1', category: '조각', subcategory: '수치 의미 파악',
  question: '30%는 무엇의 수치인가?', choiceList: ['재구매율', '이탈률', '전환율', '응답률'], answerIndex: 0,
};

const answer = (patch) => ({
  questionId: 'q-1', videoId: 'v1', domain: '발표', category: '조각', subcategory: '수치 의미 파악', repeatIndex: 0,
  condition: 'A', isCorrect: false, isUnknown: false, isResponseError: false, chosenIndex: 1, ...patch,
});

test('정답률·도달률·증가폭·AR 과 알 수 없음 비율, 응답 오류는 분모에서 뺀다', () => {
  const answerList = [
    answer({ questionId: 'q-1', condition: 'A', isCorrect: false, isUnknown: true, chosenIndex: 4 }),
    answer({ questionId: 'q-2', condition: 'A', isCorrect: true }),
    answer({ questionId: 'q-1', condition: 'S', isCorrect: true }),
    answer({ questionId: 'q-2', condition: 'S', isCorrect: true }),
    answer({ questionId: 'q-1', condition: 'C', isCorrect: true }),
    answer({ questionId: 'q-2', condition: 'C', isCorrect: true }),
    answer({ questionId: 'q-3', condition: 'C', isResponseError: true }),
    answer({ questionId: 'q-1', condition: 'H', isCorrect: true }),
  ];
  const metric = computeDerivedMetric({ answerList });
  assert.equal(metric.conditionMap.A.ca, 0.5);
  assert.equal(metric.conditionMap.A.unknownRatio, 0.5);
  assert.equal(metric.conditionMap.C.ca, 1);
  assert.equal(metric.conditionMap.C.errorCount, 1);
  assert.equal(metric.reachRate, 1);
  assert.equal(metric.reachGain, 0.5);
  assert.equal(metric.accuracyRatio, 1, 'H 가 있는 q-1 만으로 (S−A)÷(H−A) = (1−0)÷(1−0)');
  assert.equal(computeDerivedMetric({ answerList: answerList.filter((item) => item.condition !== 'H') }).accuracyRatio, null);
  const metrics = buildE2eMetrics({ answerList: answerList.map((item) => ({ ...item, language: item.questionId === 'q-2' ? 'en' : 'ko' })) });
  assert.deepEqual(Object.keys(metrics.byGroup), ['발표 · 조각 · 수치 의미 파악']);
  assert.deepEqual(Object.keys(metrics.byLanguage).sort(), ['en', 'ko']);
  assert.equal(summarizeRepeatMetric({ answerList }).repeatCount, 1);
});

test('AR 은 H 답이 응답 오류인 문항을 A·S 짝에서도 뺀다', () => {
  const answerList = [
    answer({ questionId: 'q-1', condition: 'A', isCorrect: false }),
    answer({ questionId: 'q-1', condition: 'S', isCorrect: true }),
    answer({ questionId: 'q-1', condition: 'H', isCorrect: true }),
    answer({ questionId: 'q-2', condition: 'A', isCorrect: true }),
    answer({ questionId: 'q-2', condition: 'S', isCorrect: false }),
    answer({ questionId: 'q-2', condition: 'H', isResponseError: true }),
  ];
  assert.equal(computeDerivedMetric({ answerList }).accuracyRatio, 1, 'q-1 만으로 (1−0)÷(1−0)');
});

// 영상 v1 문항 10개는 S 8개·C 9개·A 4개를 맞히고, v2 문항 10개는 S 2개·A 1개를 맞히고 C 는 건너뛰었다(no_slide).
function buildUnpairedReachAnswerList() {
  const answerList = [];
  for (const [videoId, correctCountMap] of [['v1', { S: 8, C: 9, A: 4 }], ['v2', { S: 2, A: 1 }]]) {
    for (let index = 0; index < 10; index += 1) {
      for (const [condition, correctCount] of Object.entries(correctCountMap)) {
        answerList.push(answer({ questionId: `${videoId}-q${index}`, videoId, condition, isCorrect: index < correctCount }));
      }
    }
  }
  return answerList;
}

test('도달률·증가폭은 같은 문항·반복에서 S·C(증가폭은 A·S·C)가 모두 답한 짝끼리 세고 짝 수를 남긴다', () => {
  const answerList = buildUnpairedReachAnswerList();
  const metric = computeDerivedMetric({ answerList });
  assert.equal(metric.conditionMap.S.ca, 0.5, '조건 표의 CA 는 답한 전부');
  assert.ok(Math.abs(metric.reachRate - 0.8 / 0.9) < 1e-9, `C 가 있는 v1 짝만으로 0.8÷0.9 (지금 ${metric.reachRate})`);
  assert.equal(metric.reachPairCount, 10);
  assert.ok(Math.abs(metric.reachGain - (0.8 - 0.4) / 0.9) < 1e-9, `v1 짝만으로 (0.8−0.4)÷0.9 (지금 ${metric.reachGain})`);
  assert.equal(metric.reachGainPairCount, 10);

  const withErrorList = answerList.map((item) => (item.questionId === 'v1-q0' && item.condition === 'C' ? { ...item, isResponseError: true, isCorrect: false } : item));
  const withError = computeDerivedMetric({ answerList: withErrorList });
  assert.equal(withError.reachPairCount, 9, 'C 가 응답 오류인 문항은 짝에서 빠진다');
  assert.ok(Math.abs(withError.reachRate - (7 / 9) / (8 / 9)) < 1e-9);
  const withoutA = computeDerivedMetric({ answerList: answerList.filter((item) => item.condition !== 'A') });
  assert.equal(withoutA.reachGain, null);
  assert.equal(withoutA.reachGainPairCount, 0);

  const report = buildE2eReport({
    runInfo: {
      startedAt: 't', questionPath: 'q.json', questionCount: 20, videoCount: 2, modelId: 'm', generatorModel: 'g', isSameModelWarning: false,
      conditionList: ['A', 'S', 'H', 'C'], repeatCount: 1, concurrency: 1, maxSlideCount: 20, cacheDir: null, runDirMap: {}, runStatusMap: {},
    },
    metrics: buildE2eMetrics({ answerList }), repeatSummary: summarizeRepeatMetric({ answerList }), skippedList: [],
  });
  assert.match(report, /도달률 S÷C: 0\.889 \(S·C 짝 n=10\)/);
  assert.match(report, /도달률 증가폭 \(S−A\)÷C: 0\.444 \(A·S·C 짝 n=10\)/);
  assert.match(report, /\| 0\.889 \(n=10\) \| 0\.444 \(n=10\) \|/);
});

test('answers.csv 는 문항×조건 한 줄이고 알 수 없음은 오답(0), 응답 오류는 칸을 비운다', () => {
  const csv = buildAnswerCsv({
    modelId: 'anthropic.claude-sonnet-5',
    answerList: [
      answer({ condition: 'S', isCorrect: true, chosenIndex: 0 }),
      answer({ condition: 'A', isUnknown: true, chosenIndex: 4, subcategory: '변화·비교 파악' }),
      answer({ condition: 'C', isResponseError: true, chosenIndex: null }),
    ],
  });
  const lineList = csv.trim().split('\n');
  assert.equal(lineList[0], ANSWER_CSV_COLUMN_LIST.join(','));
  assert.equal(lineList[1], 'LLM,,anthropic.claude-sonnet-5,1,v1,발표,q-1,조각,수치 의미 파악,S,0,0,1,0');
  assert.equal(lineList[2], 'LLM,,anthropic.claude-sonnet-5,1,v1,발표,q-1,조각,변화·비교 파악,A,4,1,0,0');
  assert.equal(lineList[3], 'LLM,,anthropic.claude-sonnet-5,1,v1,발표,q-1,조각,수치 의미 파악,C,,,,1');
});

test('필터: N·V 는 풀리면 폐기, C 는 못 풀면 폐기, 응답 오류는 판단하지 않는다', () => {
  assert.equal(decideFilter({ answer: answer({ condition: 'N', isCorrect: true }) }).decision, 'discard');
  assert.equal(decideFilter({ answer: answer({ condition: 'V', isCorrect: false }) }).decision, 'keep');
  assert.equal(decideFilter({ answer: answer({ condition: 'C', isCorrect: false }) }).decision, 'discard');
  assert.equal(decideFilter({ answer: answer({ condition: 'C', isResponseError: true }) }).decision, 'undecided');
  const decisionList = summarizeFilterDecision({
    questionSet: { questionList: [question] },
    answerList: [answer({ condition: 'N', isCorrect: false }), answer({ condition: 'C', isCorrect: true }), answer({ condition: 'V', isCorrect: true })],
  });
  assert.equal(decisionList[0].decision, 'discard');
  assert.deepEqual(decisionList[0].reasonList, ['V: 화면만으로 풀림 — 화면만으로 충분하다']);
});

test('필터: 판단하지 못한 필터가 있고 폐기 사유가 없는 문항은 유지가 아니라 "판단 못 함" 이다', () => {
  const decisionList = summarizeFilterDecision({
    questionSet: { questionList: [question, { ...question, id: 'q-2' }, { ...question, id: 'q-3' }] },
    answerList: [
      answer({ questionId: 'q-1', condition: 'N', isCorrect: false }), answer({ questionId: 'q-1', condition: 'C', isResponseError: true }),
      answer({ questionId: 'q-2', condition: 'N', isCorrect: true }), answer({ questionId: 'q-2', condition: 'C', isResponseError: true }),
      answer({ questionId: 'q-3', condition: 'N', isCorrect: false }), answer({ questionId: 'q-3', condition: 'C', isCorrect: true }),
    ],
  });
  assert.deepEqual(decisionList.map((decision) => [decision.questionId, decision.decision]), [
    ['q-1', 'undecided'], ['q-2', 'discard'], ['q-3', 'keep'],
  ]);
  assert.deepEqual(decisionList[0].reasonList, ['C: 응답 오류']);
  assert.deepEqual(countFilterDecision({ decisionList }), { keep: 1, discard: 1, undecided: 1 });
  const report = buildFilterReport({ runInfo: { startedAt: 't', questionPath: 'q.json', filterList: ['N', 'C'], modelId: 'm', runStatusMap: {} }, decisionList });
  assert.match(report, /유지 1개 · 폐기 1개 · 판단 못 함 1개/);
  assert.match(report, /\| q-1 \| 판단 못 함 \| C: 응답 오류 \|/);
});

test('문항 생성 모델과 답변 모델이 같으면 알아본다', () => {
  assert.equal(isSameModel({ generatorModel: 'gpt-5', modelId: 'anthropic.claude-sonnet-5' }), false);
  assert.equal(isSameModel({ generatorModel: 'claude-sonnet-5', modelId: 'us.anthropic.claude-sonnet-5' }), true);
});

const questionSet = {
  generatorModel: 'gpt-5',
  videoList: [{ videoId: 'v1', domain: '발표', language: 'ko', file: 'v1.mp4', humanAdList: [{ startMs: 4000, text: '막대: 재구매율 30%' }] }],
  questionList: [question],
};

test('작업 목록은 문항×조건×반복이고 같은 요청은 캐시로 다시 묻지 않는다', async () => {
  const material = readRunMaterial({ runDir: writeRunDir() });
  const { taskList, skippedList } = buildAnswerTaskList({
    questionSet, materialMap: new Map([['v1', material]]), kindList: ['A', 'S', 'H', 'C'], repeatCount: 2,
    instructionKind: INSTRUCTION_KIND_MAP.eval,
  });
  assert.equal(taskList.length, 8);
  assert.deepEqual(skippedList, []);
  let callCount = 0;
  const cache = createCacheStore({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cache-')) });
  const requestAnswer = async () => { callCount += 1; return { text: '{"answer": 1, "reason": "x"}', stopReason: 'end_turn' }; };
  await runAnswerTaskList({ taskList, requestAnswer, cache, modelId: 'm', concurrency: 3 });
  assert.equal(callCount, 8);
  const answerList = await runAnswerTaskList({ taskList, requestAnswer, cache, modelId: 'm', concurrency: 3 });
  assert.equal(callCount, 8);
  assert.ok(answerList.every((item) => item.isCacheHit && item.isCorrect));
});

test('e2e 명령은 토큰이 없으면 멈추고, 있으면 report·metrics·answers.jsonl·answers.csv 를 쓴다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cmd-'));
  const questionFile = path.join(dir, 'questions.json');
  fs.writeFileSync(questionFile, JSON.stringify(questionSet, null, 2));
  const runDir = writeRunDir();
  assert.equal(await runE2eCommand({ argList: ['--questions', questionFile], env: {}, log: () => {} }), 1);
  const outDir = path.join(dir, 'out');
  const code = await runE2eCommand({
    argList: ['--questions', questionFile, '--run', `v1=${runDir}`, '--no-cache', '--out-dir', outDir],
    env: { AWS_BEARER_TOKEN_BEDROCK: 'token-for-test' },
    log: () => {},
    requestAnswer: async ({ messageList }) => {
      const hasHint = JSON.stringify(messageList).includes('재구매율 막대') || JSON.stringify(messageList).includes('jpeg');
      return { text: `{"answer": ${hasHint ? 1 : 5}}`, stopReason: 'end_turn' };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['answers.csv', 'answers.jsonl', 'metrics.json', 'report.md']);
  const { metrics } = JSON.parse(fs.readFileSync(path.join(outDir, 'metrics.json'), 'utf8'));
  assert.equal(metrics.overall.conditionMap.A.ca, 0);
  assert.equal(metrics.overall.conditionMap.S.ca, 1);
  assert.equal(metrics.overall.reachGain, 1);
  assert.match(fs.readFileSync(path.join(outDir, 'report.md'), 'utf8'), /C 조건 한계/);
  assert.match(fs.readFileSync(path.join(outDir, 'report.md'), 'utf8'), /language="ko"/);
  assert.ok(Object.keys(metrics.byLanguage).includes('ko'));
  assert.doesNotMatch(fs.readFileSync(path.join(outDir, 'answers.jsonl'), 'utf8'), /token-for-test/);
});

test('e2e 필터 명령은 지시 없는 프롬프트로 묻고 유지·폐기 목록을 쓴다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-filter-'));
  const questionFile = path.join(dir, 'questions.json');
  fs.writeFileSync(questionFile, JSON.stringify(questionSet));
  const outDir = path.join(dir, 'out');
  const systemPromptList = [];
  const code = await runE2eCommand({
    argList: ['--questions', questionFile, '--run', `v1=${writeRunDir()}`, '--filter', 'N,V,C', '--no-cache', '--out-dir', outDir],
    env: { AWS_BEARER_TOKEN_BEDROCK: 'token-for-test' },
    log: () => {},
    requestAnswer: async ({ systemPrompt }) => { systemPromptList.push(systemPrompt); return { text: '{"answer": 1}' }; },
  });
  assert.equal(code, 0);
  assert.ok(systemPromptList.every((prompt) => !prompt.includes('제공된 자료만')));
  const { decisionList } = JSON.parse(fs.readFileSync(path.join(outDir, 'filter.json'), 'utf8'));
  assert.equal(decisionList[0].decision, 'discard', '문항만으로 풀렸다');
  assert.ok(fs.existsSync(path.join(outDir, 'report.md')));
});

test('보기 글 그대로 낸 답은 글 답으로 읽고, 조건별로 글 답·요청 실패 수를 센다', async () => {
  const material = readRunMaterial({ runDir: writeRunDir() });
  const { taskList } = buildAnswerTaskList({
    questionSet, materialMap: new Map([['v1', material]]), kindList: ['A', 'S'], instructionKind: INSTRUCTION_KIND_MAP.eval,
  });
  const requestAnswer = async ({ messageList }) => {
    if (JSON.stringify(messageList).includes('재구매율 막대')) throw new Error('Bedrock(e2e 답변) HTTP 429 Too many requests');
    return { text: '재구매율', stopReason: 'end_turn' };
  };
  const answerList = await runAnswerTaskList({ taskList, requestAnswer, cache: createCacheStore(), modelId: 'm', concurrency: 2 });
  const answerMap = Object.fromEntries(answerList.map((item) => [item.condition, item]));
  assert.equal(answerMap.A.source, 'text');
  assert.equal(answerMap.A.isCorrect, true);
  assert.equal(answerMap.S.isResponseError, true);
  assert.match(answerMap.S.errorMessage, /429/);
  const metric = computeDerivedMetric({ answerList });
  assert.equal(metric.conditionMap.A.textAnswerCount, 1);
  assert.equal(metric.conditionMap.A.answeredCount, 1);
  assert.equal(metric.conditionMap.S.errorCount, 1);
  assert.equal(metric.conditionMap.S.requestFailCount, 1);
  assert.equal(metric.conditionMap.S.ca, null);
});

test('결과 폴더를 못 읽은 영상은 멈추지 않고 이유와 함께 건너뛴다(N 은 자료 없이 묻는다)', async () => {
  const { taskList, skippedList } = buildAnswerTaskList({
    questionSet, materialMap: new Map(), materialErrorMap: new Map([['v1', 'ENOENT: s-condition.txt']]),
    kindList: ['N', 'V', 'C'], instructionKind: INSTRUCTION_KIND_MAP.filter,
  });
  assert.deepEqual(taskList.map((task) => task.condition), ['N']);
  assert.deepEqual(skippedList.map((skipped) => [skipped.condition, skipped.reason]), [
    ['V', TASK_SKIP_REASON_MAP.runDirUnreadable], ['C', TASK_SKIP_REASON_MAP.runDirUnreadable],
  ]);
  assert.match(skippedList[0].detail, /s-condition\.txt/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-broken-'));
  const questionFile = path.join(dir, 'questions.json');
  fs.writeFileSync(questionFile, JSON.stringify(questionSet));
  const brokenRunDir = writeRunDir();
  fs.rmSync(path.join(brokenRunDir, 's-condition.txt'));
  const outDir = path.join(dir, 'out');
  const logList = [];
  const code = await runE2eCommand({
    argList: ['--questions', questionFile, '--run', `v1=${brokenRunDir}`, '--no-cache', '--out-dir', outDir],
    env: { AWS_BEARER_TOKEN_BEDROCK: 'token-for-test' },
    log: (line) => logList.push(line),
    requestAnswer: async () => { throw new Error('부르면 안 된다'); },
  });
  assert.equal(code, 0);
  const { skippedList: writtenSkippedList } = JSON.parse(fs.readFileSync(path.join(outDir, 'metrics.json'), 'utf8'));
  assert.deepEqual([...new Set(writtenSkippedList.map((skipped) => skipped.reason))], [TASK_SKIP_REASON_MAP.runDirUnreadable]);
  assert.equal(writtenSkippedList.length, 4);
  assert.ok(logList.some((line) => /결과 폴더를 읽지 못했다/.test(line)));
  assert.match(fs.readFileSync(path.join(outDir, 'report.md'), 'utf8'), /run_dir_unreadable/);
});

test('화면 자료는 Bedrock 한도(이미지 수·한 장 크기·요청 크기)에 맞춰 장수를 줄이고 그 사실을 남긴다', () => {
  assert.equal(BEDROCK_REQUEST_LIMIT_MAP.maxImageCount, 20);
  const slideList = Array.from({ length: 30 }, (_unused, index) => ({
    label: String(index + 1), startMediaMs: index * 1000, filePath: `/virtual/slide-${index + 1}.jpg`,
  }));
  const material = { runDir: '/virtual', transcriptText: '[00:01] 말', utteranceList: [], sConditionText: '', slideList };
  const readImage = (filePath) => Buffer.alloc(filePath.endsWith('/slide-2.jpg') ? 5000 : 1000);
  const { taskList, screenMaterialList } = buildAnswerTaskList({
    questionSet, materialMap: new Map([['v1', material]]), kindList: ['C'], instructionKind: INSTRUCTION_KIND_MAP.eval,
    maxSlideCount: 30, readImage, requestLimitMap: { maxImageCount: 20, maxImageBytes: 4000, maxMaterialBytes: 15000 },
  });
  const imageCount = taskList[0].request.messageList[0].content.filter((block) => block.image).length;
  assert.ok(imageCount >= 1 && imageCount < 20, `보낸 장수 ${imageCount}`);
  assert.equal(screenMaterialList.length, 1);
  const [summary] = screenMaterialList;
  assert.equal(summary.condition, 'C');
  assert.equal(summary.availableSlideCount, 30);
  assert.equal(summary.sentSlideCount, imageCount);
  assert.ok(summary.materialBytes <= 15000);
  assert.ok(summary.noteList.some((note) => /20장/.test(note)), summary.noteList.join(' / '));
  assert.ok(summary.noteList.some((note) => /슬라이드 2/.test(note)), summary.noteList.join(' / '));
  assert.ok(summary.noteList.some((note) => /요청 크기/.test(note)), summary.noteList.join(' / '));
});

test('영상 끝까지 가지 않은 실행은 결과 폴더 상태로 알리고 전사 뒤 사람 AD 수를 남긴다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-partial-'));
  const questionFile = path.join(dir, 'questions.json');
  fs.writeFileSync(questionFile, JSON.stringify({
    ...questionSet,
    videoList: [{ ...questionSet.videoList[0], humanAdList: [{ startMs: 4000, text: '막대: 재구매율 30%' }, { startMs: 30000, text: '나중 화면' }] }],
  }));
  const runDir = writeRunDir();
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ mode: 'delayed', isComplete: true, videoEndedWallMs: null, videoDurationMs: 60000 }));
  const outDir = path.join(dir, 'out');
  const logList = [];
  const code = await runE2eCommand({
    argList: ['--questions', questionFile, '--run', `v1=${runDir}`, '--condition', 'A,H', '--no-cache', '--out-dir', outDir],
    env: { AWS_BEARER_TOKEN_BEDROCK: 'token-for-test' },
    log: (line) => logList.push(line),
    requestAnswer: async () => ({ text: '{"answer": 1}' }),
  });
  assert.equal(code, 0);
  const { runInfo } = JSON.parse(fs.readFileSync(path.join(outDir, 'metrics.json'), 'utf8'));
  const status = runInfo.runStatusMap.v1;
  assert.equal(status.isComplete, true);
  assert.equal(status.isVideoEnded, false);
  assert.equal(status.transcriptEndMs, 6000);
  assert.equal(status.humanAdAfterTranscriptCount, 1);
  assert.ok(logList.some((line) => /영상 끝까지 가지 않았다/.test(line)), logList.join('\n'));
  const report = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
  assert.match(report, /## 결과 폴더 상태/);
  assert.match(report, /영상 끝까지 가지 않았다/);
});

test('반복·동시 호출·슬라이드 수는 1 이상의 정수만 받는다', async () => {
  for (const optionList of [['--repeat', '2.5'], ['--concurrency', '0'], ['--max-slides', 'x']]) {
    const code = await runE2eCommand({
      argList: ['--questions', 'questions.json', ...optionList], env: { AWS_BEARER_TOKEN_BEDROCK: 'token-for-test' }, log: () => {},
    });
    assert.equal(code, 2, optionList.join(' '));
  }
});

test('Bedrock 요청이 실패하면 결과는 쓰되 크게 알리고 1 로 끝난다(평가·필터 모두)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-fail-'));
  const questionFile = path.join(dir, 'questions.json');
  fs.writeFileSync(questionFile, JSON.stringify(questionSet));
  const runDir = writeRunDir();
  const expiredAnswer = async () => { throw new Error('Bedrock(e2e 답변) HTTP 403 {"message":"The security token included in the request is expired"}'); };

  const evalLogList = [];
  const evalOutDir = path.join(dir, 'out-eval');
  const evalCode = await runE2eCommand({
    argList: ['--questions', questionFile, '--run', `v1=${runDir}`, '--no-cache', '--out-dir', evalOutDir],
    env: { AWS_BEARER_TOKEN_BEDROCK: 'token-for-test' }, log: (line) => evalLogList.push(line), requestAnswer: expiredAnswer,
  });
  assert.equal(evalCode, 1);
  assert.deepEqual(fs.readdirSync(evalOutDir).sort(), ['answers.csv', 'answers.jsonl', 'metrics.json', 'report.md']);
  const evalLogText = evalLogList.join('\n');
  assert.match(evalLogText, /\[e2e\] 실패: Bedrock 요청 4건이 실패했다 \(전체 4건\)/);
  assert.match(evalLogText, /HTTP 403/);
  assert.match(evalLogText, /캐시에 넣지 않으므로 같은 명령을 다시 돌리면 그것만 다시 묻는다/);
  assert.match(evalLogList.at(-1), /실패: Bedrock 요청/, '마지막 줄에 남긴다');
  assert.match(fs.readFileSync(path.join(evalOutDir, 'report.md'), 'utf8').split('\n').slice(0, 12).join('\n'), /주의: Bedrock 요청 4건이 실패/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(evalOutDir, 'metrics.json'), 'utf8')).runInfo.requestFailCount, 4);

  const filterLogList = [];
  const filterOutDir = path.join(dir, 'out-filter');
  const filterCode = await runE2eCommand({
    argList: ['--questions', questionFile, '--run', `v1=${runDir}`, '--filter', 'N,V,C', '--no-cache', '--out-dir', filterOutDir],
    env: { AWS_BEARER_TOKEN_BEDROCK: 'token-for-test' }, log: (line) => filterLogList.push(line), requestAnswer: expiredAnswer,
  });
  assert.equal(filterCode, 1);
  const filterJson = JSON.parse(fs.readFileSync(path.join(filterOutDir, 'filter.json'), 'utf8'));
  assert.equal(filterJson.decisionList[0].decision, 'undecided');
  assert.deepEqual(filterJson.decisionCountMap, { keep: 0, discard: 0, undecided: 1 });
  assert.match(fs.readFileSync(path.join(filterOutDir, 'report.md'), 'utf8'), /판단 못 함 1개/);
  assert.match(filterLogList.join('\n'), /\[e2e\] 실패: Bedrock 요청 3건이 실패했다/);
});
