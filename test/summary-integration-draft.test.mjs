import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildIntegrationDraft, isDraftCompressed, COMPRESSED_DRAFT_RATIO, COMPRESSION_CHECK_MIN_INPUT_CHARS,
} = require('../src/main/summary/integration-draft.js');

// 긴 회의에서 통합 초안이 이따금 슬라이드 여럿을 뭉뚱그려 입력의 4분의 1도 안 되게 짧아진다(구간을 절반 가까이 빠뜨림).
// 그때 한 번 더 만들고 긴 쪽을 쓴다. 넷째 부분이 빠졌으면 그 부분만 따로 만들어 붙인다.
const LONG_INPUT = '가'.repeat(10000);
const FULL_DRAFT = `개요\n회의.\n\n다룬 주제\n주제.\n\n슬라이드별 내용\n${'나'.repeat(3000)}\n\n결정된 것과 앞으로 할 일\n없습니다.`;
const SHORT_DRAFT = '개요\n회의.\n\n다룬 주제\n주제.\n\n슬라이드별 내용\n짧다.\n\n결정된 것과 앞으로 할 일\n없습니다.';

function createAgent(responseList) {
  const callList = [];
  return {
    callList,
    summarize: async (args) => {
      callList.push(['summarize', args]);
      const next = responseList.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    summarizeDecisionPart: async (args) => {
      callList.push(['decision', args]);
      return { text: '결정된 것과 앞으로 할 일\n다시 보기로 했습니다.' };
    },
  };
}

test('짧아진 초안: 입력 6000자 이상에서 초안이 입력의 0.25배보다 짧으면 짧아진 것이다', () => {
  assert.equal(COMPRESSED_DRAFT_RATIO, 0.25);
  assert.equal(COMPRESSION_CHECK_MIN_INPUT_CHARS, 6000);
  assert.equal(isDraftCompressed({ draftText: '가'.repeat(2499), integrationText: LONG_INPUT }), true);
  assert.equal(isDraftCompressed({ draftText: '가'.repeat(2500), integrationText: LONG_INPUT }), false);
  // 짧은 회의는 입력이 작고 초안이 입력만 하거나 더 길다. 입력이 작으면 보지 않는다.
  assert.equal(isDraftCompressed({ draftText: '가', integrationText: '가'.repeat(5999) }), false);
});

test('통합 초안: 짧아지지 않았으면 한 번만 묻고 그대로 쓴다', async () => {
  const agent = createAgent([{ text: FULL_DRAFT, isTruncated: false }]);
  const result = await buildIntegrationDraft({ integrationText: LONG_INPUT, language: 'ko', summaryAgent: agent });
  assert.deepEqual(agent.callList.map(([kind]) => kind), ['summarize']);
  assert.deepEqual(result, { text: FULL_DRAFT, isTruncated: false, isRetried: false, isDecisionCompleted: false });
});

test('통합 초안: 짧아졌으면 한 번 더 묻고 긴 쪽을 쓴다', async () => {
  const agent = createAgent([{ text: SHORT_DRAFT, isTruncated: false }, { text: FULL_DRAFT, isTruncated: false }]);
  const result = await buildIntegrationDraft({ integrationText: LONG_INPUT, language: 'en', summaryAgent: agent });
  assert.deepEqual(agent.callList, [
    ['summarize', { integrationText: LONG_INPUT, language: 'en' }],
    ['summarize', { integrationText: LONG_INPUT, language: 'en' }],
  ]);
  assert.deepEqual(result, { text: FULL_DRAFT, isTruncated: false, isRetried: true, isDecisionCompleted: false });

  // 다시 만든 것이 길이 한도에서 잘렸으면(되풀이로 한도를 채운 꼴) 잘리지 않은 처음 것을 쓴다.
  const truncatedAgent = createAgent([{ text: SHORT_DRAFT, isTruncated: false }, { text: FULL_DRAFT, isTruncated: true }]);
  const keptFirst = await buildIntegrationDraft({ integrationText: LONG_INPUT, summaryAgent: truncatedAgent });
  assert.deepEqual(keptFirst, { text: SHORT_DRAFT, isTruncated: false, isRetried: true, isDecisionCompleted: false });

  // 다시 만든 것이 더 짧으면 처음 것을 쓴다.
  const shorterAgent = createAgent([{ text: SHORT_DRAFT, isTruncated: false }, { text: '개요\n짧음.', isTruncated: false }]);
  const kept = await buildIntegrationDraft({ integrationText: LONG_INPUT, summaryAgent: shorterAgent });
  assert.equal(kept.text, SHORT_DRAFT);
  assert.equal(kept.isRetried, true);
});

test('통합 초안: 다시 묻다 실패하면 처음 초안을 쓰고, 처음 요청의 실패는 그대로 던진다', async (context) => {
  const warnMock = context.mock.method(console, 'warn', () => {});
  const agent = createAgent([{ text: SHORT_DRAFT, isTruncated: false }, new Error('VLM(회의 요약) HTTP 503')]);
  const result = await buildIntegrationDraft({ integrationText: LONG_INPUT, summaryAgent: agent });
  assert.equal(result.text, SHORT_DRAFT);
  assert.equal(warnMock.mock.callCount(), 1);

  const failingAgent = createAgent([new Error('VLM(회의 요약) 시간 초과')]);
  await assert.rejects(buildIntegrationDraft({ integrationText: LONG_INPUT, summaryAgent: failingAgent }), /시간 초과/);
});

test('통합 초안: 넷째 부분이 빠졌으면 고른 초안에 그 부분을 붙인다', async () => {
  const withoutDecision = `개요\n회의.\n\n다룬 주제\n주제.\n\n슬라이드별 내용\n${'나'.repeat(3000)}`;
  const agent = createAgent([{ text: withoutDecision, isTruncated: false }]);
  const result = await buildIntegrationDraft({ integrationText: LONG_INPUT, language: 'ko', summaryAgent: agent });
  assert.deepEqual(agent.callList.map(([kind]) => kind), ['summarize', 'decision']);
  assert.equal(result.text, `${withoutDecision}\n\n결정된 것과 앞으로 할 일\n다시 보기로 했습니다.`);
  assert.equal(result.isDecisionCompleted, true);
});
