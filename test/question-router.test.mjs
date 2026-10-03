import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatElapsed } = require('../src/main/caption-pipeline/context/clock-format.js');
const {
  selectFollowUpQa, buildRouterPrompt, parseRouterResponse, createQuestionRouter,
} = require('../src/main/caption-pipeline/context/question-router.js');

const index = [
  { major: 1, displayNumber: null, title: '회사 소개', keywordList: ['미션'], summary: '', firstSeenTs: 1000, isCurrent: false },
  { major: 3, displayNumber: 171, title: '반기 연봉 조정', keywordList: ['연봉', '+500'], summary: '', firstSeenTs: 151000, isCurrent: false },
  { major: 5, displayNumber: null, title: '복지', keywordList: [], summary: '', firstSeenTs: 400000, isCurrent: true },
];

test('경과 시각은 mm:ss, 1시간을 넘으면 h:mm:ss, 모르면 --:--', () => {
  assert.equal(formatElapsed({ ts: 151000, startedAt: 1000 }), '02:30');
  assert.equal(formatElapsed({ ts: 3_601_000, startedAt: 0 }), '1:00:01');
  assert.equal(formatElapsed({ ts: 500, startedAt: 1000 }), '00:00');
  assert.equal(formatElapsed({ ts: 1, startedAt: null }), '--:--');
});

test('직전 Q&A 는 60초 이내이고 되묻기가 아닐 때만 붙인다', () => {
  const lastQa = { ts: 10_000, question: 'q', answer: 'a', slideMajorList: [3], isFollowUp: false };
  assert.equal(selectFollowUpQa({ lastQa, now: 70_000 }), lastQa);
  assert.equal(selectFollowUpQa({ lastQa, now: 70_001 }), null);
  assert.equal(selectFollowUpQa({ lastQa: { ...lastQa, isFollowUp: true }, now: 11_000 }), null);
  assert.equal(selectFollowUpQa({ lastQa: null, now: 0 }), null);
});

test('라우터 프롬프트는 색인·현재 슬라이드·직전 Q&A·질문을 담는다', () => {
  const prompt = buildRouterPrompt({
    questionText: '거기서 두 번째는?', currentSlideMajor: 5, index, startedAt: 1000,
    followUpQa: { question: '연봉 슬라이드 뭐였어?', answer: '반기 조정', slideMajorList: [3] },
  });
  assert.match(prompt, /현재 슬라이드 id: 5/);
  assert.match(prompt, /3 \| 슬라이드 171 \| 반기 연봉 조정 \| 연봉, \+500 \| 02:30/);
  assert.match(prompt, /5 \| 슬라이드 5 \| 복지 \| - \| 06:39 \| 현재/);
  assert.match(prompt, /slideMajorList 에는 근거가 될 슬라이드의 id/);
  assert.match(prompt, /대상 슬라이드: 3/);
  assert.match(prompt, /질문: 거기서 두 번째는\?/);
  assert.doesNotMatch(buildRouterPrompt({ questionText: 'q', currentSlideMajor: null, index: [], startedAt: 0, followUpQa: null }), /직전 질문/);
});

test('라우터 응답 해석: 모르는 갈래·색인에 없는 번호는 버리고 최대 3장', () => {
  assert.deepEqual(parseRouterResponse({ text: '```json\n{"route": "past_slide", "slideMajorList": [3, "1", 9, 3]}\n```', index }), { route: 'past_slide', slideMajorList: [3, 1] });
  assert.equal(parseRouterResponse({ text: '{"route": "weather", "slideMajorList": []}', index }), null);
  assert.equal(parseRouterResponse({ text: '{"route": "past_slide", "slideMajorList": [9]}', index }), null);
  assert.deepEqual(parseRouterResponse({ text: '{"route": "meeting_flow"}', index }), { route: 'meeting_flow', slideMajorList: [] });
});

test('라우터는 LLM 결과를 돌려주고, 실패하면 지금 화면으로 대체한다', async () => {
  const router = createQuestionRouter({ requestText: async () => '{"route": "speaker", "slideMajorList": [3]}' });
  assert.deepEqual(
    await router.route({ questionText: 'q', currentSlideMajor: 5, index, startedAt: 0, followUpQa: null }),
    { route: 'speaker', slideMajorList: [3], source: 'llm', reason: '' },
  );
  const brokenRouter = createQuestionRouter({ requestText: async () => '몰라요' });
  const fallback = await brokenRouter.route({ questionText: 'q', currentSlideMajor: 5, index, startedAt: 0, followUpQa: null });
  assert.equal(fallback.route, 'current_screen');
  assert.deepEqual(fallback.slideMajorList, [5]);
  assert.equal(fallback.source, 'fallback');
  const failingRouter = createQuestionRouter({ requestText: async () => { throw new Error('timeout'); } });
  const failed = await failingRouter.route({ questionText: 'q', currentSlideMajor: null, index, startedAt: 0, followUpQa: null });
  assert.equal(failed.route, 'current_screen');
  assert.deepEqual(failed.slideMajorList, []);
  assert.match(failed.reason, /timeout/);
});
