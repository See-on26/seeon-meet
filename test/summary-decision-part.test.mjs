import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildDecisionPartPrompt, buildSummarySystemPrompt, SUMMARY_PART_TITLE_MAP,
} = require('../src/main/caption-pipeline/prompts/meeting-summary.js');
const { buildSummaryRewriteSystemPrompt } = require('../src/main/caption-pipeline/prompts/summary-rewrite.js');
const { createMeetingSummaryAgent } = require('../src/main/caption-pipeline/output/meeting-summary-agent.js');
const { VLM_PRIORITY_MAP } = require('../src/main/caption-pipeline/agents/shared/vlm-gateway.js');
const { isDecisionPartMissing, completeDecisionPart } = require('../src/main/summary/decision-part.js');
const { createSummaryGenerator } = require('../src/main/summary/summary-generator.js');

// 긴 회의에서 통합 초안이 셋째 부분(슬라이드별 내용)까지만 쓰고 넷째 부분 없이 끝나는 일이 있다.
// 그때만 넷째 부분을 따로 만들어 붙인다.
const KOREAN_TITLE_LIST = ['개요', '다룬 주제', '슬라이드별 내용', '결정된 것과 앞으로 할 일'];
const ENGLISH_TITLE_LIST = ['Overview', 'Topics', 'Slide by slide', 'Decisions and next steps'];
const DRAFT_WITHOUT_DECISION = '개요\n분기 실적 회의.\n\n다룬 주제\n매출\n\n슬라이드별 내용\n매출이 10퍼센트 늘었습니다.';
const DECISION_PART = '결정된 것과 앞으로 할 일\n다음 분기 목표를 다시 잡기로 했습니다.';
const INTEGRATION_TEXT = '[00:00~01:00] 슬라이드 1 — 분기 매출\n매출이 늘었다. 다음 분기 목표를 다시 잡기로 했다.';

test('요약 네 부분 제목: 한국어·영어 제목 목록은 지시문의 구성 순서와 같다', () => {
  assert.deepEqual(SUMMARY_PART_TITLE_MAP.ko, KOREAN_TITLE_LIST);
  assert.deepEqual(SUMMARY_PART_TITLE_MAP.en, ENGLISH_TITLE_LIST);
  // 넷째 부분 판정은 이 목록을 쓰므로, 요약·재작성 지시문이 적은 제목과 어긋나면 판정이 조용히 꺼진다.
  for (const language of ['ko', 'en']) {
    const titleText = SUMMARY_PART_TITLE_MAP[language].join(' / ');
    assert.ok(buildSummarySystemPrompt({ language }).includes(titleText), `${language} 요약 지시문에 ${titleText}`);
    assert.ok(buildSummaryRewriteSystemPrompt({ language }).includes(titleText), `${language} 재작성 지시문에 ${titleText}`);
  }
});

test('넷째 부분 빠짐: 셋째 제목 줄은 있는데 넷째 제목 줄이 없을 때만 빠진 것으로 본다', () => {
  assert.equal(isDecisionPartMissing({ draftText: DRAFT_WITHOUT_DECISION }), true);
  assert.equal(isDecisionPartMissing({ draftText: `${DRAFT_WITHOUT_DECISION}\n\n${DECISION_PART}` }), false);
  assert.equal(isDecisionPartMissing({ draftText: `${DRAFT_WITHOUT_DECISION}\n\n결정된 것과 앞으로 할 일:\n없습니다.` }), false, '제목 뒤 쌍점도 제목이다');
  // 제목 줄을 아예 쓰지 않은 초안은 넷째 부분이 문장으로 들어 있을 수 있어 건드리지 않는다.
  assert.equal(isDecisionPartMissing({ draftText: '이번 회의는 매출을 다뤘습니다.\n정해진 것은 없습니다.' }), false);
  assert.equal(isDecisionPartMissing({ draftText: 'Overview\nA.\n\nSlide by slide\nB.', language: 'en' }), true);
  assert.equal(isDecisionPartMissing({ draftText: 'Overview\nA.\n\nSlide by slide\nB.\n\nDecisions and next steps\nNone.', language: 'en' }), false);
});

test('넷째 부분 빠짐: 제목에 번호·꾸밈·대소문자가 섞이거나 넷째 제목이 문장으로 이어져도 있는 것으로 본다', () => {
  const presentList = [
    '결정된 것과 앞으로 할 일은 없습니다.', '결정된 것과 앞으로 할 일입니다.', '4. 결정된 것과 앞으로 할 일',
    '**결정된 것과 앞으로 할 일**', '[결정된 것과 앞으로 할 일]', '결정된 것과 앞으로 할 일 — 없습니다.',
  ];
  for (const decisionLine of presentList) {
    assert.equal(isDecisionPartMissing({ draftText: `${DRAFT_WITHOUT_DECISION}\n\n${decisionLine}` }), false, decisionLine);
  }
  assert.equal(isDecisionPartMissing({ draftText: 'Overview\nA.\n\nSlide by slide\nB.\n\nDecisions and Next Steps\nNone.', language: 'en' }), false);
  // 꾸민 셋째 제목에서 빠진 넷째 부분도 잡는다.
  assert.equal(isDecisionPartMissing({ draftText: '개요\n회의.\n\n3. 슬라이드별 내용\n매출.' }), true);
  assert.equal(isDecisionPartMissing({ draftText: '개요\n회의.\n\n**슬라이드별 내용**\n매출.' }), true);
});

test('넷째 부분 보충: 빠졌으면 통합 입력으로 넷째 부분만 만들어 한 줄 띄우고 붙인다', async () => {
  const callList = [];
  const summaryAgent = { summarizeDecisionPart: async (args) => { callList.push(args); return { text: DECISION_PART }; } };
  const result = await completeDecisionPart({ draftText: DRAFT_WITHOUT_DECISION, integrationText: INTEGRATION_TEXT, language: 'ko', summaryAgent });
  assert.deepEqual(callList, [{ integrationText: INTEGRATION_TEXT, language: 'ko' }]);
  assert.deepEqual(result, { text: `${DRAFT_WITHOUT_DECISION}\n\n${DECISION_PART}`, isCompleted: true });

  // 모델이 제목 줄 없이 내용만 주면 제목 줄을 앞에 붙인다.
  const bodyOnlyAgent = { summarizeDecisionPart: async () => ({ text: '다음 분기 목표를 다시 잡기로 했습니다.' }) };
  const bodyOnly = await completeDecisionPart({ draftText: DRAFT_WITHOUT_DECISION, integrationText: INTEGRATION_TEXT, summaryAgent: bodyOnlyAgent });
  assert.equal(bodyOnly.text, `${DRAFT_WITHOUT_DECISION}\n\n${DECISION_PART}`);
});

test('넷째 부분 보충: 꾸민 제목으로 답하면 꾸밈 없는 제목 한 줄로 바꿔 붙인다', async () => {
  const decoratedAgent = { summarizeDecisionPart: async () => ({ text: '**결정된 것과 앞으로 할 일**\n다음 분기 목표를 다시 잡기로 했습니다.', isTruncated: false }) };
  const result = await completeDecisionPart({ draftText: DRAFT_WITHOUT_DECISION, integrationText: INTEGRATION_TEXT, summaryAgent: decoratedAgent });
  assert.equal(result.text, `${DRAFT_WITHOUT_DECISION}\n\n${DECISION_PART}`);
});

test('넷째 부분 보충: 답이 길이 한도에서 잘렸거나 다른 부분까지 다시 썼으면 버리고 초안을 그대로 둔다', async (context) => {
  const warnMock = context.mock.method(console, 'warn', () => {});
  const truncatedAgent = { summarizeDecisionPart: async () => ({ text: '결정된 것과 앞으로 할 일\n다음 분기 목표를', isTruncated: true }) };
  const rewrittenAgent = { summarizeDecisionPart: async () => ({ text: `개요\n회의.\n\n슬라이드별 내용\n매출.\n\n${DECISION_PART}`, isTruncated: false }) };
  for (const summaryAgent of [truncatedAgent, rewrittenAgent]) {
    assert.deepEqual(await completeDecisionPart({ draftText: DRAFT_WITHOUT_DECISION, integrationText: INTEGRATION_TEXT, summaryAgent }), {
      text: DRAFT_WITHOUT_DECISION, isCompleted: false,
    });
  }
  assert.equal(warnMock.mock.callCount(), 2, '버린 까닭을 남긴다');
});

test('넷째 부분 보충: 빠지지 않았으면 묻지 않고, 묻다 실패하면 초안을 그대로 둔다', async (context) => {
  const warnMock = context.mock.method(console, 'warn', () => {});
  let callCount = 0;
  const countingAgent = { summarizeDecisionPart: async () => { callCount += 1; return { text: DECISION_PART }; } };
  const complete = `${DRAFT_WITHOUT_DECISION}\n\n${DECISION_PART}`;
  assert.deepEqual(await completeDecisionPart({ draftText: complete, integrationText: INTEGRATION_TEXT, summaryAgent: countingAgent }), {
    text: complete, isCompleted: false,
  });
  assert.equal(callCount, 0);

  const failingAgent = { summarizeDecisionPart: async () => { throw new Error('VLM(회의 요약 넷째 부분) HTTP 503'); } };
  assert.deepEqual(await completeDecisionPart({ draftText: DRAFT_WITHOUT_DECISION, integrationText: INTEGRATION_TEXT, summaryAgent: failingAgent }), {
    text: DRAFT_WITHOUT_DECISION, isCompleted: false,
  });
  assert.equal(warnMock.mock.callCount(), 1, '실패를 남긴다');
});

test('넷째 부분 지시문: 그 부분만 제목 줄부터 쓰게 하고, 영어면 영어 제목과 출력 언어 규칙을 붙인다', () => {
  const korean = buildDecisionPartPrompt({ language: 'ko' });
  assert.equal(buildDecisionPartPrompt(), korean, '언어를 주지 않으면 한국어');
  assert.match(korean, /첫 줄은 제목 "결정된 것과 앞으로 할 일" 한 줄이다/);
  assert.match(korean, /넷째 부분만 출력한다/);
  assert.match(korean, /정해진 것이 없으면 없다고 분명히 적는다/);
  assert.match(korean, /"…하기로 했습니다"처럼 끝맺은 문장으로 쓴다/);
  assert.match(korean, /의견·우려·설명은 결정이 아니다/);
  assert.match(korean, /지난 답변·과거 계획·전망을 이번 회의의 결정처럼 쓰지 마라/);
  assert.doesNotMatch(korean, /\[출력 언어\]|Decisions and next steps/);
  const english = buildDecisionPartPrompt({ language: 'en' });
  assert.match(english, /첫 줄은 제목 "Decisions and next steps" 한 줄이다/);
  assert.match(english, /\[출력 언어\]/);
  assert.ok(!english.includes('"결정된 것과 앞으로 할 일"'));
});

test('요약 에이전트: 넷째 부분은 배경 순위·maxTokens 800 으로 따로 묻고 빈 답은 던진다', async () => {
  const config = { vlmUrl: 'http://gpu.test/v1/chat/completions', vlmModel: 'gemma' };
  const requestList = [];
  let nextResponse = { content: `\`\`\`\n${DECISION_PART}\n\`\`\``, finishReason: 'stop' };
  const agent = createMeetingSummaryAgent({ config, requestCompletion: async (request) => { requestList.push(request); return nextResponse; } });
  assert.deepEqual(await agent.summarizeDecisionPart({ integrationText: INTEGRATION_TEXT, language: 'ko' }), { text: DECISION_PART, isTruncated: false });
  const [request] = requestList;
  assert.equal(request.timeoutMs, 60000);
  assert.equal(request.prompt, `${buildDecisionPartPrompt({ language: 'ko' })}\n\n${INTEGRATION_TEXT}`);
  assert.equal(request.priority, VLM_PRIORITY_MAP.background);
  assert.equal(request.maxTokens, 800);
  assert.equal(request.temperature, 0.2);
  assert.equal(typeof request.label, 'string');
  nextResponse = { content: DECISION_PART, finishReason: 'length' };
  assert.deepEqual(await agent.summarizeDecisionPart({ integrationText: INTEGRATION_TEXT }), { text: DECISION_PART, isTruncated: true });
  nextResponse = { content: '  ', finishReason: 'stop' };
  await assert.rejects(agent.summarizeDecisionPart({ integrationText: INTEGRATION_TEXT }), /비어 있습니다/);
});

test('요약 생성기: 통합 초안에 넷째 부분이 없으면 따로 만들어 붙인 글을 재작성에 넘긴다', async (context) => {
  context.mock.method(console, 'log', () => {});
  const summariesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-decision-'));
  const rewriteInputList = [];
  const generator = createSummaryGenerator({
    config: {},
    summariesDir,
    segmentSummaryAgent: { summarize: async () => ({ text: '매출이 늘었다.' }) },
    summaryAgent: {
      summarize: async () => ({ text: DRAFT_WITHOUT_DECISION, isTruncated: false }),
      summarizeDecisionPart: async () => ({ text: DECISION_PART }),
    },
    rewriteAgent: { rewrite: async ({ draftText }) => { rewriteInputList.push(draftText); return { text: draftText, isTruncated: false }; } },
    ttsClient: { synthesizeLong: async () => Buffer.from('mp3') },
  });
  const result = await generator.generateText({
    session: {
      sessionId: 'session-1', startedAt: 0, endedAt: 60_000, captionLanguage: 'ko',
      asrEntryList: [{ ts: 1000, text: '매출이 늘었습니다', speakerHint: null }], slideMarkList: [],
    },
  });
  assert.deepEqual(rewriteInputList, [`${DRAFT_WITHOUT_DECISION}\n\n${DECISION_PART}`]);
  assert.match(result.documentText, /\n결정된 것과 앞으로 할 일\n다음 분기 목표를 다시 잡기로 했습니다\./);
  fs.rmSync(summariesDir, { recursive: true, force: true });
});
