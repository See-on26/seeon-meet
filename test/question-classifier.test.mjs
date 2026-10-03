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
  assert.deepEqual(classifyQuestion('페이지 12').slideMajorList, [12]);
});

test('지금 누가 말하는지는 화자 레지스트리로 바로 간다', () => {
  assert.deepEqual(classifyQuestion('지금 누가 말해?'), { route: QUESTION_ROUTE_MAP.speakerNow, slideMajorList: [] });
  assert.equal(classifyQuestion('현재 말하는 사람이 누구야')?.route, QUESTION_ROUTE_MAP.speakerNow);
});

test('그 밖의 질문은 라우터로 넘긴다', () => {
  assert.equal(classifyQuestion('아까 연봉 그래프에서 하반기에 얼마 올랐어?'), null);
  assert.equal(classifyQuestion('아까 누가 연봉 얘기했어?'), null);
  assert.equal(classifyQuestion('2023년 매출이 얼마야?'), null);
  assert.equal(classifyQuestion(''), null);
});
