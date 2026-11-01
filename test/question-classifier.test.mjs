import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyQuestion, QUESTION_ROUTE_MAP } = require('../src/main/caption-pipeline/context/question-classifier.js');

test('슬라이드 번호 표현은 지난 슬라이드로 바로 간다', () => {
  for (const text of ['3번 슬라이드 제목이 뭐야?', '3 번째 슬라이드', '3페이지 내용', '3장 다시 알려줘', '슬라이드 3에 뭐 있었어?', '페이지 12']) {
    const result = classifyQuestion(text);
    assert.equal(result?.route, QUESTION_ROUTE_MAP.pastSlide, text);
  }
  assert.equal(classifyQuestion('페이지 12').spokenNumber, 12);
});

// "장"은 슬라이드를 세는 말이기도 하지만 카드·사진을 세는 말이기도 하다. 질문이 숫자로 시작할 때("3장 다시 알려줘")만
// 슬라이드 번호로 보고, "카드 4장이 뭐라고?"처럼 앞에 다른 대상이 있으면 라우터가 색인을 보고 정한다.
test('세는 말 "장"이 다른 대상을 세면 슬라이드 번호로 보지 않는다', () => {
  for (const text of ['카드 4장이 뭐라고?', '사진 2장은 뭐야?', '그 카드 4장에 뭐가 적혀 있었어?']) {
    assert.equal(classifyQuestion(text), null, text);
  }
  assert.deepEqual(classifyQuestion('3장 다시 알려줘'), { route: QUESTION_ROUTE_MAP.pastSlide, spokenNumber: 3 });
  assert.deepEqual(classifyQuestion('5번째 장 뭐였어?'), { route: QUESTION_ROUTE_MAP.pastSlide, spokenNumber: 5 });
  assert.deepEqual(classifyQuestion('아까 4번 슬라이드 내용'), { route: QUESTION_ROUTE_MAP.pastSlide, spokenNumber: 4 });
});

test('지금 누가 말하는지는 화자 레지스트리로 바로 간다', () => {
  assert.deepEqual(classifyQuestion('지금 누가 말해?'), { route: QUESTION_ROUTE_MAP.speakerNow, spokenNumber: null });
  assert.equal(classifyQuestion('현재 말하는 사람이 누구야')?.route, QUESTION_ROUTE_MAP.speakerNow);
});

test('그 밖의 질문은 라우터로 넘긴다', () => {
  assert.equal(classifyQuestion('아까 연봉 그래프에서 하반기에 얼마 올랐어?'), null);
  assert.equal(classifyQuestion('아까 누가 연봉 얘기했어?'), null);
  assert.equal(classifyQuestion('2023년 매출이 얼마야?'), null);
  assert.equal(classifyQuestion(''), null);
});

test('"지금 화면에 누구 사진이야?"는 지금 화자 질문이 아니다', () => {
  assert.equal(classifyQuestion('지금 화면에 누구 사진이야?'), null);
  assert.equal(classifyQuestion('지금 발표하는 사람 누구야?')?.route, QUESTION_ROUTE_MAP.speakerNow);
});
