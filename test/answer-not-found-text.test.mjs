import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createQuestionAnswerer, isNotFoundAnswerText, resolveAnswerText, resolveGroundedText, NOT_FOUND_TEXT, OFF_TOPIC_TEXT,
  SPEAKER_UNKNOWN_TEXT, NO_IMAGE_TEXT, readAnswerText, ANSWER_TEXT_KEY_MAP,
} = require('../src/main/caption-pipeline/context/question-answerer.js');
const { QUESTION_ROUTE_MAP } = require('../src/main/caption-pipeline/context/question-classifier.js');

// 질문의 근거가 화면·발화에 없으면 모델이 쓴 거절 문장 대신 늘 "화면과 발화에 없는 내용이에요" 로 답한다.
const ENGLISH_NOT_FOUND_TEXT = readAnswerText({ key: ANSWER_TEXT_KEY_MAP.notFound, language: 'en' });

test('거절 문장: 숫자 없이 답 전체가 못 찾았다고만 말하는 답은 근거 없음으로 본다', () => {
  const refusalList = [
    '제시된 화면에는 한국의 소금 섭취량에 대한 정보는 나와 있지 않습니다.',
    '화면에 그 내용은 나오지 않아요.', '그래프에 해당 항목이 보이지 않습니다.', '자료에 포함되어 있지 않아요.',
    '발표자가 언급되지 않은 내용이에요.', '관련 정보가 없습니다.', 'That information is not on the screen.',
    '화면에 적혀 있지 않아요.', '자료에 나타나 있지 않습니다.', '화면에 제시되어 있지 않아요.', '발표에서 확인되지 않아요.',
    '발표자가 언급하지 않았어요.', '그건 알 수가 없어요.', '발화에서 찾지 못했어요.', '화면에 없는 내용입니다.',
    '기록에는 그 사람이 누구인지 나와 있지 않습니다.', '죄송해요. 화면에 그 정보는 나와 있지 않아요.',
    "That isn't shown on the slide.", "It wasn't mentioned.", 'I could not find that.', 'It doesn’t appear on the screen.',
    'That is not provided.', 'Not shown on this slide.', 'The amount is not mentioned in the record.',
    // 앞머리 사과·축약·짧은 꼴.
    '죄송하지만 그 정보는 화면에 나와 있지 않아요.', '죄송해요, 화면에서 찾을 수 없어요.', "Sorry, I couldn't find that.",
    "That's not mentioned.", "It's not shown on the slide.", 'The slide does not mention that.', '그건 화면에 안 나와요.',
    '화면에 안 보여요.', '잘 모르겠어요.', '화면과 발화에서 찾을 수 없어요.',
    '현재 화면과 발화 기록에서는 해당 정보를 찾을 수 없습니다.', '주어진 화면과 발화만으로 알 수 없어요.', '여기서 확인할 수 없어요.',
    '죄송하지만, 화면에서 찾을 수 없어요.', 'I’m sorry, I couldn’t find that.', "Sorry, but that's not shown.",
    '그 사람의 이름은 알 수 없어요.',
  ];
  for (const text of refusalList) assert.equal(isNotFoundAnswerText(text), true, text);
});

test('거절 문장: 못 찾았다는 말이 들어 있어도 내용이 있는 답은 그대로 둔다', () => {
  const answerList = [
    // 숫자가 든 답은 일부를 못 찾았다고 해도 답이 있는 것으로 본다.
    '2023년 값은 보이지 않지만 2024년은 10.9그램이에요.', '남성은 10.9그램, 여성은 9.3그램을 섭취해요.',
    '규칙은 모음 카드의 뒷면이 홀수여야 한다는 거예요.',
    // 그래프 축·제목·화면 글자처럼 내용을 말하면서 일부만 없다고 하거나, 거절 말이 명사 앞 꼴로 들어간 답.
    '가로축은 월, 세로축은 판매량이고 단위는 표시되어 있지 않아요.', '가로축은 연도, 세로축은 매출이에요. 단위는 나와 있지 않아요.',
    '보이지 않는 위협, 사이버 보안을 다룬 PPT 발표 자료예요.', '알 수 없는 오류가 발생했다는 오류 창이 떠 있는 화면이에요.',
    'A "Page not found" error page in a web browser.',
    // 예·아니요 질문의 답, 화면에 보이는 모습을 말한 답.
    '그래프에는 뚜렷한 증가 추세가 보이지 않아요.', '아니요, 화면에 회사 로고는 보이지 않아요.',
    'The chart does not show a clear upward trend.', 'No, the company logo is not visible.',
    '앞면이 모음이면 뒷면은 짝수여야 한다는 규칙이에요. 뒷면은 화면에 보이지 않아요.',
    // 발언을 옮긴 답, 앱이 들려준 해설 원문.
    '김동욱님이 원인은 아직 알 수 없다고 말했어요.', '발표자는 아직 결론이 나오지 않았다고 말했어요.',
    '이미지 제시, 얼굴이 보이지 않는 뒷모습 사진',
    // 보이는 모습·내용을 말한 뒤 한 문장 안에서 일부만 모른다고 한 답(이음말·쉼표가 없어도).
    '정장을 입은 중년 남성으로 이름은 알 수 없어요.', '안경을 쓴 여성이 웃고 있는 사진이라 이름은 확인할 수 없어요.',
    '안경을 쓴 여성이 웃고 있어서 누구인지는 알 수 없어요.', '세 명이 회의하는 사진으로 누구인지는 확인할 수 없어요.',
    '표지 슬라이드여서 세부 내용은 알 수 없어요.', '막대 그래프로 지역별 매출을 비교했고 정확한 값은 알 수 없어요.',
    '표에 지역별 인구가 나오며 단위는 명시되어 있지 않아요.', '발표자는 비용 절감을 강조했고 예산은 언급하지 않았어요.',
    '발표자는 매출이 늘었다고 했고 이유는 언급하지 않았어요.', '세 가지 대안을 비교했으며 결론은 확인할 수 없어요.',
    '김 팀장님: 원인은 아직 확인할 수 없습니다.', '발표자는 "결과는 아직 알 수 없습니다."',
    'Kim said the penalty clause is not specified in the contract.', 'He said the deadline was not specified yet.',
    'The chart compares regional sales; exact values are not stated.', 'It was not visible because the slide changed quickly.',
    // 사람 모습을 말한 뒤 누구인지·이름만 모른다고 한 답.
    '정장을 입은 중년 남성이 누구인지는 알 수 없어요.', '사진 속 정장을 입은 남성이 누구인지는 알 수 없어요.',
    '안경을 쓴 여성이 웃고 있는 사진 속 인물이 누구인지는 확인할 수 없어요.', '정장 차림의 중년 남성이 누구인지는 나와 있지 않아요.',
    '사진 속 정장 차림의 남성이 누구인지는 화면에 나와 있지 않아요.', '빨간 넥타이 남성의 이름은 알 수 없어요.',
    '단상에서 발표하는 남성의 이름은 알 수 없어요.', '안경 쓴 여성의 이름은 알 수 없어요.',
    // 남의 말을 옮긴 답.
    '팀장님 말로는 원인은 아직 알 수 없어요.', '팀장님에 따르면 원인은 알 수 없어요.', '발표자 설명으로는 원인은 아직 알 수 없어요.',
    "김 팀장님은 '원인은 아직 확인할 수 없습니다.'",
    // 화면 글자를 따옴표로만 옮긴 답.
    '"요청하신 페이지를 찾을 수 없습니다."', "'요청하신 페이지를 찾을 수 없습니다.'", '‘요청하신 페이지를 찾을 수 없습니다.’',
  ];
  for (const text of answerList) assert.equal(isNotFoundAnswerText(text), false, text);
});

test('답 문구 고르기: 근거가 없거나 비었거나 거절 문장이면 고정 문구, 아니면 답을 그대로 쓴다', () => {
  assert.deepEqual(resolveAnswerText({ text: '', isGrounded: false }), { text: NOT_FOUND_TEXT, isGrounded: false });
  assert.deepEqual(resolveAnswerText({ text: '무엇이든', isGrounded: false }), { text: NOT_FOUND_TEXT, isGrounded: false });
  assert.deepEqual(resolveAnswerText({ text: '화면에 나와 있지 않습니다.', isGrounded: true }), { text: NOT_FOUND_TEXT, isGrounded: false });
  assert.deepEqual(resolveAnswerText({ text: 'Not shown on this slide.', isGrounded: true, language: 'en' }), {
    text: ENGLISH_NOT_FOUND_TEXT, isGrounded: false,
  });
  assert.deepEqual(resolveAnswerText({ text: '카드는 A, 3, J, 4예요.', isGrounded: true }), { text: '카드는 A, 3, J, 4예요.', isGrounded: true });
  // 앱이 정한 다른 고정 문구는 그대로 둔다.
  for (const text of [OFF_TOPIC_TEXT, SPEAKER_UNKNOWN_TEXT, NO_IMAGE_TEXT, NOT_FOUND_TEXT]) {
    assert.equal(resolveAnswerText({ text, isGrounded: true }).text, text, text);
  }
});

test('이미 거른 답·앱이 만든 문장은 근거가 없거나 비었을 때만 고정 문구로 바꾼다', () => {
  const replayText = '이미지 제시, 얼굴이 보이지 않는 뒷모습 사진';
  assert.deepEqual(resolveGroundedText({ text: replayText, isGrounded: true }), { text: replayText, isGrounded: true });
  assert.deepEqual(resolveGroundedText({ text: '화면에 나와 있지 않습니다.', isGrounded: true }), {
    text: '화면에 나와 있지 않습니다.', isGrounded: true,
  });
  assert.deepEqual(resolveGroundedText({ text: '', isGrounded: true }), { text: NOT_FOUND_TEXT, isGrounded: false });
  assert.deepEqual(resolveGroundedText({ text: replayText, isGrounded: false, language: 'en' }), {
    text: ENGLISH_NOT_FOUND_TEXT, isGrounded: false,
  });
});

test('해설 다시 듣기: 들려준 해설에 거절 말이 들어 있어도 원문 그대로 돌려준다', async () => {
  const replayText = '이미지 제시, 얼굴이 보이지 않는 뒷모습 사진';
  const contextStore = {
    getSessionInfo: () => ({ startedAt: 0 }), getQaList: () => [],
    getNarrationList: () => [{ text: replayText, slideMajor: 1, eventVideoTimeMs: null }],
  };
  const answerer = createQuestionAnswerer({
    requestText: async () => '1', requestImage: async () => '', readImage: async () => null, contextStore, now: () => 2000,
  });
  const result = await answerer.answer({ route: QUESTION_ROUTE_MAP.narrationReplay, questionText: '방금 해설 다시 말해 줘' });
  assert.deepEqual(resolveGroundedText({ text: result.text, isGrounded: result.isGrounded }), { text: replayText, isGrounded: true });
});

test('질문 답: 화자·회의 흐름 갈래도 모델의 거절 문장을 고정 문구로 바꾼다', async () => {
  const contextStore = {
    getSessionInfo: () => ({ startedAt: 0 }), getQaList: () => [], getNarrationList: () => [],
    getUtteranceList: () => [{ ts: 1000, text: '매출이 늘었습니다', speakerHint: '김동욱' }], getSlide: () => null,
    buildIndex: () => [{ major: 1, displayNumber: 1, title: '매출', summary: '' }],
  };
  const answerer = createQuestionAnswerer({
    requestText: async () => '기록에는 그 사람이 누구인지 나와 있지 않습니다.',
    requestImage: async () => '', readImage: async () => null, contextStore, now: () => 2000,
  });
  const wordBudget = { minWordCount: 2, maxWordCount: 30 };
  for (const route of [QUESTION_ROUTE_MAP.speaker, QUESTION_ROUTE_MAP.meetingFlow]) {
    const result = await answerer.answer({ route, questionText: '누가 말했어?', wordBudget });
    assert.deepEqual({ text: result.text, isGrounded: result.isGrounded }, { text: NOT_FOUND_TEXT, isGrounded: false }, route);
  }
});

test('연결: 프리셋 명령과 현재 화면 질문은 거절 문장까지 보고, 다른 갈래는 근거 여부만 보며, 근거가 없어도 고정 문구를 들려준다', () => {
  const source = fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');
  const commandStart = source.indexOf("ipcMain.handle('pipeline-command'");
  const questionStart = source.indexOf("ipcMain.handle('pipeline-question'");
  const commandBody = source.slice(commandStart, questionStart);
  const questionBody = source.slice(questionStart, source.indexOf('ipcMain.handle(', questionStart + 10));
  assert.match(commandBody, /resolveAnswerText\(/);
  assert.match(questionBody, /isCurrentScreen \? resolveAnswerText : resolveGroundedText/);
  // 근거가 없을 때 아무 말 없이 끝내던 갈래가 없어야 한다.
  assert.doesNotMatch(commandBody, /return \{ isOk: true, isGrounded: false \};/);
  assert.match(commandBody, /sendCaption\(/);
});
