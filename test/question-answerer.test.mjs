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
  store.applyRecord({ kind: 'page_transition', ts: 1100, slideLabel: '3', pageTopic: '반기 연봉 조정', description: '연봉 변화 그래프', displayNumber: 1 });
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
  assert.match(prompt, /\[슬라이드 1\] 반기 연봉 조정/, '내부 번호(3)가 아니라 사용자가 들은 번호(1)를 붙인다');
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

test('근거를 못 찾고(NONE) 볼 이미지도 없으면 없는 내용이라고 답한다', async () => {
  const { answerer } = makeAnswerer({ textReplyList: ['NONE'] });
  const result = await answerer.answer({ route: 'past_slide', slideMajorList: [4], questionText: '매출은?', wordBudget });
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
  assert.match(textCallList[0].prompt, /\[슬라이드 1\] 반기 연봉 조정/, '내부 번호(3)가 아니라 사용자가 들은 번호(1)를 붙인다');
  assert.match(textCallList[0].prompt, /\[번호 없는 화면\]/, '들은 번호가 없는 화면(4)에 내부 번호를 붙이지 않는다');
  assert.doesNotMatch(textCallList[0].prompt, /\[슬라이드 [34]\]/);
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

test('저장 이미지가 있으면 기록에서 못 찾을 때 NONE 대신 NEED_IMAGE 를 내게 한다', async () => {
  const { answerer, textCallList } = makeAnswerer({ textReplyList: ['답', '답'] });
  await answerer.answer({ route: 'past_slide', slideMajorList: [3], questionText: 'A는 얼마?', wordBudget });
  assert.match(textCallList[0].prompt, /찾을 수 없으면 정확히 "NEED_IMAGE"/);
  assert.doesNotMatch(textCallList[0].prompt, /찾을 수 없으면 정확히 "NONE"/);

  const noImageStore = makeStore();
  const { answerer: noImageAnswerer, textCallList: noImageCallList } = makeAnswerer({ store: noImageStore, textReplyList: ['답'] });
  noImageStore.getSlide(3).imagePath = null;
  await noImageAnswerer.answer({ route: 'past_slide', slideMajorList: [3], questionText: 'A는 얼마?', wordBudget });
  assert.match(noImageCallList[0].prompt, /찾을 수 없으면 정확히 "NONE"/);
  assert.doesNotMatch(noImageCallList[0].prompt, /NEED_IMAGE/);
});

test('해설 다시는 가장 최근 해설을 표시하고, 특정 해설을 가리키지 않으면 그것을 고르게 한다', async () => {
  const store = makeStore();
  store.applyRecord({ kind: 'narration', ts: 3000, source: 'page-transition', text: '슬라이드 4: 복지', slideLabel: '4', isEmitted: true });
  const { answerer, textCallList } = makeAnswerer({ store, textReplyList: ['2'] });
  await answerer.answer({ route: 'narration_replay', slideMajorList: [], questionText: '방금 해설 다시', wordBudget });
  const { prompt } = textCallList[0];
  assert.match(prompt, /2\. 슬라이드 4: 복지 \(가장 최근\)/);
  assert.match(prompt, /가장 최근 번호/);
});

test('지난 슬라이드 답이 "명시되어 있지 않다" 같은 못 찾음 설명이면 저장 이미지로 다시 묻는다', async () => {
  const { answerer, imageCallList } = makeAnswerer({ textReplyList: ['기록에는 A의 구체적인 금액이 명시되어 있지 않습니다.'], imageReply: 'A는 1,000이에요' });
  const result = await answerer.answer({ route: 'past_slide', slideMajorList: [3], questionText: 'A는 얼마?', wordBudget });
  assert.deepEqual(result, { text: 'A는 1,000이에요', isGrounded: true, isImageUsed: true });
  assert.equal(imageCallList.length, 1);
});

test('이미지가 없을 때 못 찾음 설명은 없는 내용으로 답한다', async () => {
  const { answerer } = makeAnswerer({ textReplyList: ['기록에서 확인할 수 없습니다'] });
  const result = await answerer.answer({ route: 'past_slide', slideMajorList: [4], questionText: 'A는 얼마?', wordBudget });
  assert.deepEqual(result, { text: NOT_FOUND_TEXT, isGrounded: false, isImageUsed: false });
});

test('교차 모드: 해설 다시는 사용자가 아직 듣지 못한 해설을 고르지 않는다', async () => {
  const store = makeStore();
  store.applyRecord({ kind: 'narration', ts: 3000, source: 'deixis', text: '들은 해설', slideLabel: '3', isEmitted: true, eventVideoTimeMs: 5000 });
  store.applyRecord({ kind: 'narration', ts: 3100, source: 'deixis', text: '아직 안 들린 해설', slideLabel: '3', isEmitted: true, eventVideoTimeMs: 50000 });
  const { answerer, textCallList } = makeAnswerer({ store, textReplyList: ['2'] });
  await answerer.answer({ route: 'narration_replay', slideMajorList: [], questionText: '방금 해설 다시', wordBudget, heardVideoTimeMs: 10000 });
  assert.match(textCallList[0].prompt, /들은 해설 \(가장 최근\)/);
  assert.doesNotMatch(textCallList[0].prompt, /아직 안 들린 해설/);
});

test('교차 모드: 화자 질문은 사용자가 들은 시점까지의 발화만 근거로 쓴다', async () => {
  const { answerer, textCallList } = makeAnswerer({ textReplyList: ['답'], now: () => 700_000 });
  await answerer.answer({ route: 'speaker', slideMajorList: [], questionText: '방금 누가 뭐라고 했어?', wordBudget, heardWallTs: 100_000 });
  assert.match(textCallList[0].prompt, /500만원이 추가됩니다/);
  assert.doesNotMatch(textCallList[0].prompt, /복지 얘기/);
});

test('교차 모드: 지금 화자는 사용자가 듣는 시점 근처 발화의 화자로 답한다', async () => {
  const { answerer } = makeAnswerer({ now: () => 62_000 });
  const lagged = await answerer.answer({ route: 'speaker_now', slideMajorList: [], questionText: 'q', wordBudget, speakerHintNow: '이수민', heardWallTs: 3_000 });
  assert.equal(lagged.text, '김지오님이 말하고 있어요');
  const live = await answerer.answer({ route: 'speaker_now', slideMajorList: [], questionText: 'q', wordBudget, speakerHintNow: '이수민', heardWallTs: 61_500 });
  assert.equal(live.text, '이수민님이 말하고 있어요');
});

test('따옴표·백틱이 붙은 NEED_IMAGE 도 이미지 요청으로 본다', async () => {
  const { answerer, imageCallList } = makeAnswerer({ textReplyList: ['"NEED_IMAGE"'], imageReply: '빨간 선' });
  const result = await answerer.answer({ route: 'past_slide', slideMajorList: [3], questionText: '색?', wordBudget });
  assert.equal(result.isImageUsed, true);
  assert.equal(imageCallList.length, 1);
});

test('숫자가 든 답은 "알 수 없지만" 같은 말이 있어도 버리지 않는다', async () => {
  const { answerer, imageCallList } = makeAnswerer({ textReplyList: ['정확한 날짜는 알 수 없지만 500만원이 추가됐어요'] });
  const result = await answerer.answer({ route: 'past_slide', slideMajorList: [3], questionText: '얼마?', wordBudget: { minWordCount: 3, maxWordCount: 20 } });
  assert.equal(result.isImageUsed, false);
  assert.equal(imageCallList.length, 0);
  assert.match(result.text, /500만원/);
});

test('설명 문장 뒤에 NEED_IMAGE 를 붙여도 저장 이미지로 다시 묻고, 토큰을 소리 내 읽지 않는다', async () => {
  const { answerer, imageCallList } = makeAnswerer({
    textReplyList: ['기록에는 빨간 막대가 우리 회사인지에 대한 정보가 없습니다. NEED_IMAGE'], imageReply: '빨간 막대가 저희 회사예요',
  });
  const result = await answerer.answer({ route: 'past_slide', slideMajorList: [3], questionText: '빨간 막대가 우리 회사야?', wordBudget });
  assert.equal(imageCallList.length, 1);
  assert.equal(result.text, '빨간 막대가 저희 회사예요');
  assert.doesNotMatch(result.text, /NEED_IMAGE/);
});

test('답 길이 규칙은 답을 찾았을 때만 적용한다 — 못 찾으면 토큰만 내게 한다', async () => {
  const { answerer, textCallList } = makeAnswerer({ textReplyList: ['하반기에 500 올랐어요'] });
  await answerer.answer({ route: 'past_slide', slideMajorList: [3], questionText: '얼마 올랐어?', wordBudget });
  assert.match(textCallList[0].prompt, /답을 찾았으면 .*1~2문장/);
});
