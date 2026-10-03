import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createContextStore } = require('../src/main/caption-pipeline/context/context-store.js');
const {
  createQuestionAnswerer, NOT_FOUND_TEXT, NO_IMAGE_TEXT, SPEAKER_UNKNOWN_TEXT,
} = require('../src/main/caption-pipeline/context/question-answerer.js');

const wordBudget = { minWordCount: 3, maxWordCount: 15 };

function makeStore() {
  const store = createContextStore();
  store.start({ sessionId: 's', startedAt: 0 });
  store.applyRecord({ kind: 'slide_mark', ts: 1000, slideLabel: '3', frameKind: 'base', filePath: '/tmp/3.jpg' });
  store.applyRecord({ kind: 'page_transition', ts: 1100, slideLabel: '3', pageTopic: '반기 연봉 조정', description: '연봉 변화 그래프' });
  store.applySlideText({ slideLabel: '3', status: 'ready', text: '1,000(A) 1,250(B) 1,500(C) +500' });
  store.applyRecord({ kind: 'asr', ts: 2000, text: '500만원이 추가됩니다', speakerHint: '김지오', segmentList: [{ startSec: 0, endSec: 2, text: '500만원이 추가됩니다' }] });
  store.applyRecord({ kind: 'narration', ts: 2500, source: 'deixis', text: '연봉 그래프 보는 중', slideLabel: '3', isEmitted: true });
  store.applyRecord({ kind: 'slide_mark', ts: 600_000, slideLabel: '4', frameKind: 'base', filePath: '/tmp/missing.jpg' });
  store.applyRecord({ kind: 'asr', ts: 601_000, text: '복지 얘기', speakerHint: null, segmentList: [{ startSec: 0, endSec: 1, text: '복지 얘기' }] });
  return store;
}

function makeAnswerer({ store = makeStore(), textReplyList = ['답'], imageReply = '이미지 답', imageMap = { '/tmp/3.jpg': Buffer.from('jpg') }, now = () => 700_000 } = {}) {
  const textCallList = [];
  const imageCallList = [];
  const answerer = createQuestionAnswerer({
    contextStore: store,
    requestText: async (args) => { textCallList.push(args); return textReplyList.shift(); },
    requestImage: async (args) => { imageCallList.push(args); return imageReply; },
    readImage: async (filePath) => imageMap[filePath] || null,
    now,
  });
  return { answerer, textCallList, imageCallList };
}

test('지난 슬라이드는 저장 텍스트(주제·글자·발화·해설)로 답한다', async () => {
  const { answerer, textCallList } = makeAnswerer({ textReplyList: ['하반기에 500 올랐어요'] });
  const result = await answerer.answer({ route: 'past_slide', slideMajorList: [3], questionText: '하반기에 얼마 올랐어?', wordBudget });
  assert.deepEqual(result, { text: '하반기에 500 올랐어요', isGrounded: true, isImageUsed: false });
  const { prompt } = textCallList[0];
  assert.match(prompt, /\[슬라이드 3\] 반기 연봉 조정/);
  assert.match(prompt, /1,500\(C\)/);
  assert.match(prompt, /김지오: 500만원이 추가됩니다/);
  assert.match(prompt, /연봉 그래프 보는 중/);
  assert.match(prompt, /NEED_IMAGE/);
});

test('텍스트로 부족하면 저장 이미지로 다시 묻는다', async () => {
  const { answerer, imageCallList } = makeAnswerer({ textReplyList: ['NEED_IMAGE'], imageReply: '빨간 선이에요' });
  const result = await answerer.answer({ route: 'past_slide', slideMajorList: [3], questionText: '선 색이 뭐였어?', wordBudget });
  assert.deepEqual(result, { text: '빨간 선이에요', isGrounded: true, isImageUsed: true });
  assert.equal(imageCallList[0].jpegBuffer.toString(), 'jpg');
  assert.match(imageCallList[0].prompt, /선 색이 뭐였어/);
});

test('이미지 파일이 없으면 그림 정보가 없다고 답한다', async () => {
  const { answerer } = makeAnswerer({ textReplyList: ['NEED_IMAGE'] });
  const result = await answerer.answer({ route: 'past_slide', slideMajorList: [4], questionText: '색?', wordBudget });
  assert.deepEqual(result, { text: NO_IMAGE_TEXT, isGrounded: true, isImageUsed: false });
});

test('근거를 못 찾으면(NONE) 없는 내용이라고 답한다', async () => {
  const { answerer } = makeAnswerer({ textReplyList: ['NONE'] });
  const result = await answerer.answer({ route: 'past_slide', slideMajorList: [3], questionText: '매출은?', wordBudget });
  assert.deepEqual(result, { text: NOT_FOUND_TEXT, isGrounded: false, isImageUsed: false });
});

test('지금 화자는 레지스트리 힌트로 바로 답한다', async () => {
  const { answerer, textCallList } = makeAnswerer();
  assert.equal((await answerer.answer({ route: 'speaker_now', slideMajorList: [], questionText: 'q', wordBudget, speakerHintNow: '김지오' })).text, '김지오님이 말하고 있어요');
  assert.equal((await answerer.answer({ route: 'speaker_now', slideMajorList: [], questionText: 'q', wordBudget, speakerHintNow: null })).text, SPEAKER_UNKNOWN_TEXT);
  assert.equal(textCallList.length, 0);
});

test('화자 질문은 대상 슬라이드가 없으면 최근 10분 발화를 근거로 쓴다', async () => {
  const { answerer, textCallList } = makeAnswerer({ textReplyList: ['복지 얘기를 했어요'], now: () => 650_000 });
  await answerer.answer({ route: 'speaker', slideMajorList: [], questionText: '방금 무슨 얘기 했어?', wordBudget });
  const { prompt } = textCallList[0];
  assert.match(prompt, /복지 얘기/);
  assert.doesNotMatch(prompt, /500만원/);
  assert.match(prompt, /\[10:01\] 복지 얘기/);
});

test('해설 다시는 고른 해설을 원문 그대로 돌려준다', async () => {
  const { answerer, textCallList } = makeAnswerer({ textReplyList: ['1'] });
  const result = await answerer.answer({ route: 'narration_replay', slideMajorList: [], questionText: '아까 해설 다시', wordBudget });
  assert.deepEqual(result, { text: '연봉 그래프 보는 중', isGrounded: true, isImageUsed: false });
  assert.match(textCallList[0].prompt, /1\. 연봉 그래프 보는 중/);
});

test('회의 흐름은 색인과 슬라이드별 발화 앞부분으로 답한다', async () => {
  const { answerer, textCallList } = makeAnswerer({ textReplyList: ['연봉과 복지를 다뤘어요'] });
  await answerer.answer({ route: 'meeting_flow', slideMajorList: [], questionText: '지금까지 무슨 얘기?', wordBudget });
  assert.match(textCallList[0].prompt, /\[슬라이드 3\] 반기 연봉 조정/);
  assert.match(textCallList[0].prompt, /\[슬라이드 4\]/);
});

test('none 갈래는 모델 없이 없는 내용이라고 답한다', async () => {
  const { answerer, textCallList } = makeAnswerer();
  const result = await answerer.answer({ route: 'none', slideMajorList: [], questionText: '날씨?', wordBudget });
  assert.deepEqual(result, { text: NOT_FOUND_TEXT, isGrounded: false, isImageUsed: false });
  assert.equal(textCallList.length, 0);
});

test('답은 어절 상한으로 자른다', async () => {
  const { answerer } = makeAnswerer({ textReplyList: ['하나 둘 셋 넷 다섯 여섯'] });
  const result = await answerer.answer({ route: 'meeting_flow', slideMajorList: [], questionText: 'q', wordBudget: { minWordCount: 1, maxWordCount: 3 } });
  assert.equal(result.text, '하나 둘 셋…');
});
