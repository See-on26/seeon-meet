import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildScreenTextBlock, selectScreenTextLineList, extractKeywordList, SCREEN_TEXT_MAX_CHARS,
} = require('../src/main/caption-pipeline/prompts/screen-text-block.js');

const line = (text, extra = {}) => ({ text, score: 0.95, height: 30, ...extra });

const HEADER_LINE_LIST = [
  '참고: 아래는 같은 화면을 글자 인식기(OCR)로 읽은 글자다. 위에서 아래 순서이고, 같은 높이에 있는 다른 칸의 글자가 한 줄로 이어졌을 수 있다.',
  '  값·항목 이름의 철자는 여기서 확인하되, 어느 값이 어느 항목의 것인지는 반드시 이미지에서 확인한다. 이미지와 다르면 이미지를 따른다.',
];
const claimSentence = (count) => `화면 글자에 숫자가 있는 줄이 ${count}개 있다. 그 숫자가 발표자가 말한 대상과 관련 있으면 "화면에 수치가 없다"는 이유로 NONE 을 내지 않는다.`;
const EMPTY_BLOCK = { text: '', lineCount: 0, charCount: 0, numberLineCount: 0 };

test('상한은 600자', () => {
  assert.equal(SCREEN_TEXT_MAX_CHARS, 600);
});

test('줄이 없거나 공백뿐이면 덩어리가 없다', () => {
  for (const lineList of [[], [line(''), line('   ')], undefined, null, [{ score: 0.9 }]]) {
    assert.deepEqual(
      buildScreenTextBlock({ lineList, keywordSourceList: ['매출이 늘었습니다'], isClaimToValue: true }),
      EMPTY_BLOCK, JSON.stringify(lineList),
    );
  }
});

test('덩어리 모양: 안내 두 줄 · 따옴표로 감싼 OCR 줄(앞뒤 공백 뗌) · 변화·비교이고 숫자 줄이 있으면 NONE 막는 문장', () => {
  const block = buildScreenTextBlock({
    lineList: [line('3분기 매출'), line('  182억  '), line('전년 대비 크게 증가')],
    keywordSourceList: ['마지막 분기에 매출이 크게 뛰었습니다.'], isClaimToValue: true,
  });
  assert.equal(block.text, [
    ...HEADER_LINE_LIST, '"""', '3분기 매출', '182억', '전년 대비 크게 증가', '"""', claimSentence(2),
  ].join('\n'));
  assert.equal(block.lineCount, 3);
  assert.equal(block.charCount, '3분기 매출'.length + '182억'.length + '전년 대비 크게 증가'.length);
  assert.equal(block.numberLineCount, 2);
});

test('값→의미 덩어리에는 NONE 막는 문장도, 말한 수가 적힌 줄 짚기도 없다', () => {
  const block = buildScreenTextBlock({
    lineList: [line('RSU 79개 설치'), line('WAVE 단말기 3,000개')], keywordSourceList: ['79개, 이 숫자가 의미가 큽니다.'],
  });
  assert.equal(block.text, [...HEADER_LINE_LIST, '"""', 'RSU 79개 설치', 'WAVE 단말기 3,000개', '"""'].join('\n'));
  assert.doesNotMatch(block.text, /NONE|적힌 줄/);
  assert.equal(block.numberLineCount, 2);
});

test('숫자 줄이 없으면 변화·비교라도 NONE 막는 문장을 넣지 않는다', () => {
  const block = buildScreenTextBlock({
    lineList: [line('감사합니다'), line('질문을 받겠습니다')], keywordSourceList: ['참여가 크게 늘었습니다.'], isClaimToValue: true,
  });
  assert.equal(block.text, [...HEADER_LINE_LIST, '"""', '감사합니다', '질문을 받겠습니다', '"""'].join('\n'));
  assert.equal(block.numberLineCount, 0);
});

// 글자 많은 화면(회의록 30줄): 위에서부터 600자를 자르면 29번째 줄 "대만 1,145건"이 빠진다.
const denseLineList = Array.from({ length: 30 }, (_, index) => line(
  index === 28
    ? '29.해외 판매는 일본 1,920건,대만 1,145건,싱가포르 688건이다.'
    : `${String(index + 1).padStart(2, '0')}.운영 지표 항목 ${index + 1}의 이번 달 수치는 ${index + 10}.5%였다.`,
));

test('600자 상한: 발화 낱말이 든 줄을 먼저 넣고, 고른 줄은 원래 위→아래 순서로 둔다', () => {
  const selectedList = selectScreenTextLineList({ lineList: denseLineList, keywordSourceList: ['대만 판매도 꽤 많았습니다.'] });
  const totalChars = denseLineList.reduce((sum, item) => sum + item.text.length, 0);
  assert.ok(totalChars > SCREEN_TEXT_MAX_CHARS, '시험 자료는 상한보다 길어야 한다');
  assert.ok(selectedList.includes(denseLineList[28].text), '대만 줄이 남는다');
  assert.ok(selectedList.join('').length <= SCREEN_TEXT_MAX_CHARS);
  const indexList = selectedList.map((text) => denseLineList.findIndex((item) => item.text === text));
  assert.deepEqual(indexList, [...indexList].sort((left, right) => left - right), '원래 순서');
  assert.equal(indexList[0], 0, '나머지는 위에서부터 채운다');
  const withoutKeyword = selectScreenTextLineList({ lineList: denseLineList, keywordSourceList: ['꽤 많았습니다.'] });
  assert.ok(!withoutKeyword.includes(denseLineList[28].text), '낱말이 없으면 위에서부터 자른다');
});

test('600자 상한: 낱말 줄 다음은 숫자가 있는 줄, 그다음이 나머지 줄', () => {
  const letterList = [...'가나다라마바사아자차카타'];
  const lineList = [
    ...letterList.map((letter) => line(`글머리 문장 ${letter} — 숫자 없는 설명이 길게 이어지는 줄입니다 가나다라마바사아자차카타파하`)),
    line('영업이익 17.6억 원'), line('매출 132억 원'), line('이익률 13.3%'),
  ];
  const selectedList = selectScreenTextLineList({ lineList, keywordSourceList: ['크게 늘었습니다'] });
  for (const text of ['영업이익 17.6억 원', '매출 132억 원', '이익률 13.3%']) assert.ok(selectedList.includes(text), text);
  assert.ok(selectedList.length < lineList.length);
  assert.ok(selectedList.join('').length <= SCREEN_TEXT_MAX_CHARS);
  assert.equal(selectedList.at(-1), '이익률 13.3%', '원래 순서라 숫자 줄이 뒤에 온다');
});

test('상한을 넘는 한 줄은 건너뛰고 다음 줄을 본다', () => {
  const selectedList = selectScreenTextLineList({
    lineList: [line('가'.repeat(30)), line('나'.repeat(80)), line('다'.repeat(20))], keywordSourceList: [], maxChars: 60,
  });
  assert.deepEqual(selectedList, ['가'.repeat(30), '다'.repeat(20)]);
});

test('발화 낱말: 조사를 떼고 두 글자 이상만 본다(한 글자 낱말·조사만 남는 말은 보지 않는다)', () => {
  const { wordList } = extractKeywordList(['이직률은 업계 평균보다 훨씬 낮습니다. 대만 판매도 꽤 많았습니다.']);
  for (const word of ['이직률', '업계', '평균', '대만', '판매']) assert.ok(wordList.includes(word), word);
  assert.ok(!wordList.includes('꽤'));
  assert.ok(wordList.every((word) => word.length >= 2), JSON.stringify(wordList));
  const selectedList = selectScreenTextLineList({
    lineList: [...Array.from({ length: 20 }, (_, index) => line(`항목 ${index} 설명 문장이 여기에 길게 들어갑니다 가나다라`)), line('22.연환산 이직률은 9.6%로 업계 평균 12.1%보다 낮다.')],
    keywordSourceList: ['이직률은 업계 평균보다 훨씬 낮습니다.'], maxChars: 120,
  });
  assert.ok(selectedList.includes('22.연환산 이직률은 9.6%로 업계 평균 12.1%보다 낮다.'));
});

// 앞의 숫자 줄("수치 12%")이 상한을 먼저 차지하므로, 뒤 줄이 남으면 낱말 줄로 먼저 뽑힌 것이다.
const pickAgainstNumberLine = ({ text, keyword, maxChars = text.length }) => selectScreenTextLineList({
  lineList: [line('수치 12%'), line(text)], keywordSourceList: [keyword], maxChars,
});

test('발화의 숫자(두 자리 이상)는 앞뒤가 다른 숫자로 이어지지 않는 줄만 맞는다 · 쉼표 표기는 무시', () => {
  const { numberCoreList } = extractKeywordList(['79개, 2,318건이라는 숫자와 3분기 9.6%']);
  assert.deepEqual(numberCoreList, ['79', '2318', '9.6']);
  assert.deepEqual(pickAgainstNumberLine({ text: 'RSU 79개', keyword: '79개' }), ['RSU 79개']);
  assert.deepEqual(pickAgainstNumberLine({ text: '체험 계정 2318건', keyword: '2,318건' }), ['체험 계정 2318건']);
  assert.deepEqual(pickAgainstNumberLine({ text: '이직률 9.6%', keyword: '9.6%' }), ['이직률 9.6%']);
  assert.deepEqual(pickAgainstNumberLine({ text: '사업 179개', keyword: '79' }), ['수치 12%']);
  assert.deepEqual(pickAgainstNumberLine({ text: '비율 79.5%', keyword: '79' }), ['수치 12%']);
  assert.deepEqual(pickAgainstNumberLine({ text: '3분기 이익', keyword: '3분기' }), ['수치 12%'], '한 자리 숫자는 보지 않는다');
});

test('영어 낱말은 대소문자를 가리지 않고 세 글자 이상, 흔한 기능어는 보지 않는다', () => {
  const { wordList } = extractKeywordList(['The Error rate is far below the target of our team']);
  for (const word of ['error', 'rate', 'below', 'target', 'team']) assert.ok(wordList.includes(word), word);
  for (const word of ['the', 'is', 'of', 'our']) assert.ok(!wordList.includes(word), word);
  assert.deepEqual(pickAgainstNumberLine({ text: 'ERROR RATE 0.07%', keyword: 'the error rate dropped' }), ['ERROR RATE 0.07%']);
  assert.deepEqual(pickAgainstNumberLine({ text: 'ERROR RATE 0.07%', keyword: 'it is of the' }), ['수치 12%']);
});

test('둘째 근거 표현(합쳐진 변화 구)의 낱말도 본다', () => {
  const lineList = [line('처리 건수 1,204건'), line('고객 만족도 72점 → 88점')];
  const pick = (keywordSourceList) => selectScreenTextLineList({ lineList, keywordSourceList, maxChars: 16 });
  assert.deepEqual(pick(['응답 속도가 빨라졌습니다', '만족도도 꽤 많이 올랐습니다']), ['고객 만족도 72점 → 88점']);
  assert.deepEqual(pick(['응답 속도가 빨라졌습니다']), ['처리 건수 1,204건']);
});

test('입력 줄 목록을 바꾸지 않고, 같은 입력이면 같은 덩어리', () => {
  const lineList = [line(' 제목 '), line('매출 12.5%')];
  const snapshot = JSON.stringify(lineList);
  const first = buildScreenTextBlock({ lineList, keywordSourceList: ['매출'], isClaimToValue: true });
  const second = buildScreenTextBlock({ lineList, keywordSourceList: ['매출'], isClaimToValue: true });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(lineList), snapshot);
});
