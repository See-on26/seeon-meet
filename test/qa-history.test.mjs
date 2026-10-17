import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  formatQaHistory, buildPresetQa, QA_HISTORY_MAX_CHARS, PRESET_QA_ROUTE,
} = require('../src/main/caption-pipeline/context/qa-history.js');
const {
  buildCurrentScreenContextText, CURRENT_SCREEN_UTTERANCE_MAX_CHARS,
} = require('../src/main/caption-pipeline/context/current-screen-context.js');
const { buildRouterPrompt } = require('../src/main/caption-pipeline/context/question-router.js');
const { createContextStore } = require('../src/main/caption-pipeline/context/context-store.js');
const { createQuestionAnswerer } = require('../src/main/caption-pipeline/context/question-answerer.js');
const { buildFreeQuestionPrompt } = require('../src/main/caption-pipeline/prompts/command-processing.js');

// 기술 스택 점검표 댓글 #5·#6: 60초 안의 직전 질문·답 1쌍이 아니라, 웹 LLM 대화처럼 이번 회의의 질문과 답을 모두 맥락으로 넘긴다.
const qaList = [
  { ts: 10_000, question: '연봉 슬라이드 뭐였어?', answer: '반기 연봉 조정이에요', route: 'past_slide', slideMajorList: [3] },
  { ts: 600_000, question: '그거 얼마 올랐어?', answer: '500 올랐어요', route: 'past_slide', slideMajorList: [3] },
];

test('질문·답 기록은 60초·1턴 제한 없이 이번 회의 것을 오래된 것부터 모두 적는다', () => {
  assert.equal(formatQaHistory({ qaList, startedAt: 0 }),
    '[00:10] 질문: 연봉 슬라이드 뭐였어? / 답: 반기 연봉 조정이에요\n[10:00] 질문: 그거 얼마 올랐어? / 답: 500 올랐어요');
  assert.equal(formatQaHistory({ qaList: [], startedAt: 0 }), '');
});

test('기록이 8,000자를 넘으면 가장 오래된 질문부터 뺀다', () => {
  assert.equal(QA_HISTORY_MAX_CHARS, 8000);
  const longList = Array.from({ length: 200 }, (_, index) => ({
    ts: index * 1000, question: `질문${index}`, answer: '가'.repeat(60), route: 'current_screen', slideMajorList: [],
  }));
  const text = formatQaHistory({ qaList: longList, startedAt: 0 });
  assert.ok(text.length <= QA_HISTORY_MAX_CHARS, String(text.length));
  assert.match(text, /질문199 /);
  assert.doesNotMatch(text, /질문0 /);
});

// GPU 비교(10/18): 기록을 한 줄 목록으로만 주면 2분 뒤 "그럼 C 등급은?"을 0/3 지금 화면으로 보냈다.
// 직전 질문·답을 따로 세 줄로 보이고 그 전 것만 목록으로 주면 되묻기·새 질문 4경우 12/12 맞았다.
test('라우터는 직전 질문·답을 따로 보이고, 그 전 질문·답은 시간·횟수 제한 없이 목록으로 받는다', () => {
  const prompt = buildRouterPrompt({ questionText: '더 자세히', currentSlideMajor: 5, index: [], startedAt: 0, qaList });
  assert.match(prompt, /그 전 질문과 답 \(오래된 것부터\):\n질문: 연봉 슬라이드 뭐였어\? \/ 답: 반기 연봉 조정이에요 \/ 대상 슬라이드: 3\n/);
  assert.match(prompt, /직전 질문과 답 \(되묻는 질문이면 직전 대상 슬라이드를 그대로 쓴다\):\n질문: 그거 얼마 올랐어\?\n답: 500 올랐어요\n대상 슬라이드: 3/);
  const single = buildRouterPrompt({ questionText: 'q', currentSlideMajor: 5, index: [], startedAt: 0, qaList: [qaList[0]] });
  assert.doesNotMatch(single, /그 전 질문과 답/);
  assert.match(single, /직전 질문과 답[^\n]*\n질문: 연봉 슬라이드 뭐였어\?/);
});

function makeStore() {
  const store = createContextStore();
  store.start({ sessionId: 's', startedAt: 0 });
  store.applyRecord({ kind: 'slide_mark', ts: 1000, slideLabel: '3', frameKind: 'base', filePath: '/tmp/3.jpg' });
  store.applyRecord({ kind: 'page_transition', ts: 1100, slideLabel: '3', pageTopic: '반기 연봉 조정', description: '연봉 변화 그래프', displayNumber: 1 });
  for (let index = 0; index < 20; index += 1) {
    const ts = 2000 + index * 5000;
    store.applyRecord({ kind: 'asr', ts, text: `연봉 설명 ${index}번째`, speakerHint: '김지오', segmentList: [{ startSec: 0, endSec: 2, text: `연봉 설명 ${index}번째` }] });
  }
  store.applyRecord({ kind: 'narration', ts: 2500, source: 'deixis', text: '연봉 그래프 보는 중', slideLabel: '3', isEmitted: true });
  store.applyRecord({ kind: 'slide_mark', ts: 600_000, slideLabel: '4', frameKind: 'base', filePath: '/tmp/4.jpg' });
  store.applyRecord({ kind: 'asr', ts: 601_000, text: '복지 얘기', speakerHint: null, segmentList: [{ startSec: 0, endSec: 1, text: '복지 얘기' }] });
  store.applyRecord({ kind: 'narration', ts: 601_500, source: 'deixis', text: '복지 표 보는 중', slideLabel: '4', isEmitted: true });
  for (const qa of qaList) store.addQa(qa);
  return store;
}

test('답 만들기는 모든 갈래에 앞서 오간 질문과 답을 넣는다', async () => {
  const promptList = [];
  const answerer = createQuestionAnswerer({
    contextStore: makeStore(),
    requestText: async ({ prompt }) => { promptList.push(prompt); return '답이에요 확인'; },
    requestImage: async () => 'NONE', readImage: async () => null, now: () => 700_000,
  });
  const wordBudget = { minWordCount: 1, maxWordCount: 15 };
  await answerer.answer({ route: 'past_slide', slideMajorList: [3], questionText: '더 자세히', wordBudget });
  await answerer.answer({ route: 'speaker', slideMajorList: [3], questionText: '누가 말했어?', wordBudget });
  await answerer.answer({ route: 'meeting_flow', slideMajorList: [], questionText: '흐름 정리', wordBudget });
  await answerer.answer({ route: 'narration_replay', slideMajorList: [], questionText: '해설 다시', wordBudget, heardVideoTimeMs: null });
  assert.equal(promptList.length, 4);
  for (const prompt of promptList) {
    assert.match(prompt, /앞서 오간 질문과 답/);
    assert.match(prompt, /\[10:00\] 질문: 그거 얼마 올랐어\? \/ 답: 500 올랐어요/);
  }
});

test('지금 화면 자유 질문 지시문에도 앞서 오간 질문과 답을 넣는다', () => {
  const prompt = buildFreeQuestionPrompt({ questionText: '그거 어디 있어?', qaHistoryText: '[00:10] 질문: 연봉 슬라이드 뭐였어? / 답: 반기 연봉 조정이에요' });
  assert.match(prompt, /앞서 오간 질문과 답[^\n]*\n\[00:10\] 질문: 연봉 슬라이드 뭐였어\?/);
  assert.doesNotMatch(buildFreeQuestionPrompt({ questionText: 'q' }), /앞서 오간 질문/);
});

// 사용자 의견(10/18): 발표가 60초보다 길면 최근 60초 받아쓰기로는 앞 설명이 빠진다 → 지금 슬라이드에 쌓인 기록으로 답한다.
test('지금 화면 질문은 이 슬라이드에서 오간 말 전부와 들려준 해설을 받는다', () => {
  const text = buildCurrentScreenContextText({ contextStore: makeStore(), major: 3 });
  for (let index = 0; index < 20; index += 1) assert.match(text, new RegExp(`김지오: 연봉 설명 ${index}번째`));
  assert.match(text, /\[00:02\] 김지오: 연봉 설명 0번째/);
  assert.match(text, /들려준 해설: 연봉 그래프 보는 중/);
  assert.doesNotMatch(text, /복지/, '다른 슬라이드의 말·해설은 넣지 않는다');
  assert.equal(buildCurrentScreenContextText({ contextStore: makeStore(), major: null }), '');
});

test('이 슬라이드의 말이 6,000자를 넘으면 오래된 말부터 뺀다', () => {
  assert.equal(CURRENT_SCREEN_UTTERANCE_MAX_CHARS, 6000);
  const store = createContextStore();
  store.start({ sessionId: 's', startedAt: 0 });
  store.applyRecord({ kind: 'slide_mark', ts: 1000, slideLabel: '3', frameKind: 'base', filePath: '/tmp/3.jpg' });
  for (let index = 0; index < 100; index += 1) {
    const text = `말${index} ${'나'.repeat(100)}`;
    store.applyRecord({ kind: 'asr', ts: 2000 + index * 10_000, text, speakerHint: null, segmentList: [{ startSec: 0, endSec: 9, text }] });
  }
  const text = buildCurrentScreenContextText({ contextStore: store, major: 3 });
  assert.match(text, /말99 /);
  assert.doesNotMatch(text, /말0 /);
  const utteranceText = text.split('\n').filter((line) => /^\[\d/.test(line)).join('\n');
  assert.ok(utteranceText.length <= CURRENT_SCREEN_UTTERANCE_MAX_CHARS, String(utteranceText.length));
});

test('프리셋 답(무슨 자료야? 등)도 질문·답 기록에 남긴다', () => {
  assert.deepEqual(
    buildPresetQa({ ts: 5, command: 'screen_material', questionLabel: '무슨 자료야?', text: '연봉 발표 자료예요', currentSlideMajor: 3 }),
    { ts: 5, question: '무슨 자료야?', answer: '연봉 발표 자료예요', route: PRESET_QA_ROUTE, slideMajorList: [3] },
  );
  assert.deepEqual(buildPresetQa({ ts: 5, command: 'graph_axis', questionLabel: '', text: '가로축은 연도', currentSlideMajor: null }).slideMajorList, []);
  assert.equal(buildPresetQa({ ts: 5, command: 'graph_axis', questionLabel: '', text: '가로축은 연도', currentSlideMajor: null }).question, 'graph_axis');
});
