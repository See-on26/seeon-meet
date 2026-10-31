import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSummarySystemPrompt } = require('../src/main/caption-pipeline/prompts/meeting-summary.js');
const { buildSummaryRewriteSystemPrompt, buildSummaryRewriteInput } = require('../src/main/caption-pipeline/prompts/summary-rewrite.js');
const { buildSummaryDocument, formatDurationText, TRUNCATED_NOTICE } = require('../src/main/summary/summary-document.js');
const { createSummaryGenerator } = require('../src/main/summary/summary-generator.js');

// QA N3·기술 스택 점검표 #9: 캡션 언어가 English 면 회의 뒤 요약 글·요약 음성·진행 안내도 영어다.
// 세션 기록의 captionLanguage 를 쓴다(요약은 세션이 끝난 뒤에 만든다).
const HANGUL_PATTERN = /[가-힣]/;

test('요약 지시문: 한국어는 지금과 같고, 영어는 한국어 낭독용 규칙(음차·퍼센트)을 빼고 영어로 쓰게 한다', () => {
  assert.equal(buildSummarySystemPrompt({ language: 'ko' }), buildSummarySystemPrompt());
  const english = buildSummarySystemPrompt({ language: 'en' });
  assert.match(english, /\[출력 언어\]/);
  assert.match(english, /Overview, Topics, Slide by slide, Decisions and next steps/);
  assert.doesNotMatch(english, /음차|엔에프티|42퍼센트/);
  assert.match(buildSummarySystemPrompt(), /엔에프티/);
});

test('듣는 글 재구성 지시문도 영어면 영어로 다듬게 하고 음차 규칙을 뺀다', () => {
  assert.equal(buildSummaryRewriteSystemPrompt({ language: 'ko' }), buildSummaryRewriteSystemPrompt());
  const english = buildSummaryRewriteSystemPrompt({ language: 'en' });
  assert.match(english, /\[출력 언어\]/);
  assert.doesNotMatch(english, /음차|엔에프티/);
  assert.equal(buildSummaryRewriteInput({ draftText: 'd', language: 'ko' }), buildSummaryRewriteInput({ draftText: 'd' }));
});

test('요약 문서 머리 글: 영어는 Meeting summary·길이·규모·잘림 안내를 영어로', () => {
  const meetingMeta = { sessionId: 's', startedAt: 0, endedAt: 3_900_000, slideCount: 3, utteranceCount: 12 };
  assert.equal(buildSummaryDocument({ meetingMeta, bodyText: '본문' }), buildSummaryDocument({ meetingMeta, bodyText: '본문', language: 'ko' }));
  const english = buildSummaryDocument({ meetingMeta, bodyText: 'Body.', isTruncated: true, language: 'en' });
  assert.equal(english, 'Meeting summary\n\nMeeting length: 1 hour 5 minutes\n3 slides · 12 utterances\n\nBody.\n\nThis summary was cut off at the length limit, so the end is missing.\n');
  assert.ok(!HANGUL_PATTERN.test(english));
  assert.equal(formatDurationText({ ms: 45_000, language: 'en' }), '45 seconds');
  assert.equal(formatDurationText({ ms: 60_000, language: 'en' }), '1 minute');
  assert.equal(formatDurationText({ ms: 7_200_000, language: 'en' }), '2 hours');
  assert.equal(formatDurationText({ ms: 3_900_000 }), '1시간 5분');
  assert.equal(TRUNCATED_NOTICE, '이 요약은 길이 제한에 걸려 뒷부분이 잘렸습니다.');
});

test('요약 생성기는 세션 캡션 언어로 구간 요약·요약·재구성·음성 합성을 부르고 진행 안내도 그 언어로 낸다', async (context) => {
  // 단계별 진행 로그가 시험 출력에 섞이지 않게 막는다(시험이 끝나면 되돌린다).
  context.mock.method(console, 'log', () => {});
  const summariesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-language-'));
  const callList = [];
  const progressList = [];
  const generator = createSummaryGenerator({
    config: {},
    summariesDir,
    onProgress: ({ stage, message }) => progressList.push({ stage, message }),
    segmentSummaryAgent: { summarize: async (args) => { callList.push(['segment', args.language]); return { text: 'They said hello.' }; } },
    summaryAgent: { summarize: async (args) => { callList.push(['summarize', args.language]); return { text: 'Draft.', isTruncated: false }; } },
    rewriteAgent: { rewrite: async (args) => { callList.push(['rewrite', args.language]); return { text: 'Overview.', isTruncated: false }; } },
    ttsClient: { synthesizeLong: async (args) => { callList.push(['speak', args.language]); return Buffer.from('mp3'); } },
  });
  const result = await generator.generateText({
    session: {
      sessionId: 'session-1', startedAt: 0, endedAt: 60_000, captionLanguage: 'en',
      asrEntryList: [{ ts: 1000, text: 'hello', speakerHint: null }], slideMarkList: [],
    },
  });
  await generator.generateAudio({ sessionId: 'session-1', documentText: result.documentText, language: 'en' });
  assert.deepEqual(callList, [['segment', 'en'], ['summarize', 'en'], ['rewrite', 'en'], ['speak', 'en']]);
  assert.match(result.documentText, /^Meeting summary\n/);
  assert.deepEqual(progressList.map(({ stage }) => stage), ['start', 'done']);
  for (const { message } of progressList) assert.ok(!HANGUL_PATTERN.test(message), message);
  fs.rmSync(summariesDir, { recursive: true, force: true });
});
