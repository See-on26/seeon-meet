import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseJsonObject } = require('../src/main/caption-pipeline/context/parse-json-response.js');
const { buildSlideLabelPrompt } = require('../src/main/caption-pipeline/prompts/slide-label.js');
const { parseSlideLabel, createSlideLabeler } = require('../src/main/caption-pipeline/context/slide-labeler.js');

test('코드펜스와 앞뒤 설명이 붙은 JSON 도 꺼낸다', () => {
  assert.deepEqual(parseJsonObject('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('결과: {"a": 2} 입니다'), { a: 2 });
  assert.equal(parseJsonObject('{"a": '), null);
  assert.equal(parseJsonObject('[1, 2]'), null);
  assert.equal(parseJsonObject(null), null);
});

test('라벨 프롬프트는 주제·묘사·글자를 담고 글자는 1,500자까지만 넣는다', () => {
  const prompt = buildSlideLabelPrompt({ pageTopic: '주제', description: '묘사', slideText: '가'.repeat(2000) });
  assert.match(prompt, /화면 주제: 주제/);
  assert.match(prompt, /화면 묘사: 묘사/);
  const slideTextLine = prompt.split('\n').find((line) => line.startsWith('화면 글자: '));
  assert.equal(slideTextLine.length, '화면 글자: '.length + 1500);
  assert.match(buildSlideLabelPrompt({ pageTopic: '', description: '', slideText: '' }), /화면 글자: \(없음\)/);
});

test('라벨 응답을 해석하고 제목 20자·키워드 6개로 자르며 중복 키워드를 지운다', () => {
  const label = parseSlideLabel(JSON.stringify({
    title: '가나다라마바사아자차카타파하가나다라마바사아',
    keywordList: ['a', 'b', 'a', ' ', 'c', 'd', 'e', 'f', 'g'],
    summary: ' 요약 ',
  }));
  assert.equal(label.title.length, 20);
  assert.deepEqual(label.keywordList, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(label.summary, '요약');
});

test('제목도 키워드도 없으면 해석 실패', () => {
  assert.equal(parseSlideLabel('{"summary": "요약만"}'), null);
  assert.equal(parseSlideLabel('아무 말'), null);
});

test('라벨러는 프롬프트로 텍스트를 요청하고 해석 결과를 돌려준다', async () => {
  const callList = [];
  const labeler = createSlideLabeler({
    requestText: async (args) => { callList.push(args); return '{"title": "연봉", "keywordList": ["반기"], "summary": "s"}'; },
  });
  const label = await labeler.label({ slide: { pageTopic: '연봉', description: '그래프', slideText: '1,500' } });
  assert.deepEqual(label, { title: '연봉', keywordList: ['반기'], summary: 's' });
  assert.equal(callList[0].label, '슬라이드 라벨');
  assert.match(callList[0].prompt, /1,500/);
});

test('해석할 수 없는 응답이면 오류를 던진다', async () => {
  const labeler = createSlideLabeler({ requestText: async () => '모르겠어요' });
  await assert.rejects(() => labeler.label({ slide: { pageTopic: '', description: '', slideText: '' } }), /라벨 응답 해석 실패/);
});
