import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildFactCardBlock, FACT_CARD_USAGE_MAP, FACT_CARD_BLOCK_LIMIT_MAP,
} = require('../src/main/caption-pipeline/prompts/fact-card-block.js');

// 고른 카드를 해설 에이전트 프롬프트에 넣는 덩어리. 아래 화면은 모두 지어낸 예다.
const item = (label, value, note = '') => ({ label, value, note, isValueVerified: null });
const chartCard = {
  id: '3:1', kind: 'chart', title: '지역별 판매량', position: '왼쪽', period: '2023~2024', unit: '천 대',
  axisList: [{ name: '지역', from: '서울', to: '강원' }, { name: '판매량', from: '0', to: '800' }], legendList: ['2023', '2024'], headerList: [],
  itemList: [item('서울', '2023 410, 2024 520'), item('부산', '2023 300, 2024 280')], count: 5, matchedItemIndexList: [],
};
const tableCard = {
  id: '3:2', kind: 'table', title: '채널별 비중', position: '오른쪽', period: '', unit: '%', axisList: [], legendList: [],
  headerList: ['채널', '2023', '2024'], itemList: [item('온라인', '2023 35%, 2024 48%', '추정치')], count: 1, matchedItemIndexList: [],
};
const VALUE_INTRO = [
  '참고: 아래는 슬라이드가 바뀔 때 이 화면을 미리 읽어 패널별로 정리한 사실이다. 발표자가 말한 대상과 가까운 것만 골랐다.',
  '  값의 대상·기간·단위·비교 기준은 여기서 확인해 빠뜨리지 않는다. 지금 이미지와 다르면 이미지를 따르고, 여기에도 이미지에도 없는 값은 쓰지 않는다.',
];
const CHART_LINE_LIST = [
  '[사실 1] 그래프 「지역별 판매량」(왼쪽) · 기간 2023~2024 · 단위 천 대',
  '  축: 지역 서울~강원 / 판매량 0~800 · 범례: 2023, 2024 · 항목 5개',
  '  서울: 2023 410, 2024 520 / 부산: 2023 300, 2024 280',
];
const TABLE_LINE_LIST = [
  '[사실 2] 표 「채널별 비중」(오른쪽) · 단위 %',
  '  머리글: 채널 | 2023 | 2024 · 항목 1개',
  '  온라인: 2023 35%, 2024 48% (추정치)',
];
const sumLength = (lineList) => lineList.reduce((sum, text) => sum + text.length, 0);

test('상한: 수치 2장·450자, 척도 1장·250자, 지시 1장·200자', () => {
  assert.deepEqual(FACT_CARD_BLOCK_LIMIT_MAP, {
    value: { cardCount: 2, maxChars: 450 }, scale: { cardCount: 1, maxChars: 250 }, deixis: { cardCount: 1, maxChars: 200 },
  });
});

test('수치 덩어리 모양: 안내 두 줄 · 따옴표 안에 카드마다 머리 줄·구성 줄·항목 줄', () => {
  const block = buildFactCardBlock({ cardList: [chartCard, tableCard], usage: FACT_CARD_USAGE_MAP.value });
  assert.equal(block.text, [...VALUE_INTRO, '"""', ...CHART_LINE_LIST, ...TABLE_LINE_LIST, '"""'].join('\n'));
  assert.equal(block.cardCount, 2);
  assert.equal(block.charCount, sumLength([...CHART_LINE_LIST, ...TABLE_LINE_LIST]));
});

test('척도 덩어리: 둘째 안내 줄이 척도용이고 1장만 넣는다', () => {
  const block = buildFactCardBlock({ cardList: [chartCard, tableCard], usage: FACT_CARD_USAGE_MAP.scale });
  const lineList = block.text.split('\n');
  assert.equal(lineList[0], VALUE_INTRO[0]);
  assert.equal(lineList[1], '  축 범위·적힌 크기 값·같은 패널의 다른 항목을 비교 대상으로 쓸 수 있다. 지금 이미지와 다르면 이미지를 따른다.');
  assert.deepEqual(lineList.slice(2), ['"""', ...CHART_LINE_LIST, '"""']);
  assert.equal(block.cardCount, 1);
});

test('지시 덩어리에는 항목 값도 항목 이름도 넣지 않는다(이름·기간·축·범례·머리글·개수만)', () => {
  const block = buildFactCardBlock({ cardList: [chartCard, tableCard], usage: FACT_CARD_USAGE_MAP.deixis });
  assert.equal(block.text, [
    '참고: 아래는 이 화면의 한 구역 이름과 구성이다(값은 넣지 않았다).',
    '  가리킨 대상이 이 구역이면 구역 이름·기간·축 범위·항목 수를 대상 이름에 쓰고, 다른 곳을 가리켰으면 무시한다.',
    '"""', CHART_LINE_LIST[0], CHART_LINE_LIST[1], '"""',
  ].join('\n'));
  assert.doesNotMatch(block.text, /410|520|부산/);
  assert.equal(block.cardCount, 1);
});

test('글자 상한 안에서 발화가 맞힌 항목을 먼저 담고, 담은 항목은 원래 순서로 둔다', () => {
  const manyItemList = Array.from({ length: 12 }, (_, index) => item(`${index + 1}번 지역 판매 거점`, `2023 ${100 + index}, 2024 ${200 + index}`));
  const card = { ...chartCard, itemList: manyItemList, count: 12, matchedItemIndexList: [11, 9] };
  const block = buildFactCardBlock({ cardList: [card], usage: FACT_CARD_USAGE_MAP.scale });
  const itemLine = block.text.split('\n').find((text) => text.startsWith('  1번') || text.includes('12번'));
  assert.ok(itemLine.includes('12번 지역 판매 거점: 2023 111, 2024 211'), itemLine);
  assert.ok(itemLine.includes('10번 지역 판매 거점'), itemLine);
  assert.ok(itemLine.indexOf('10번') < itemLine.indexOf('12번'), '원래 순서');
  assert.ok(itemLine.startsWith('  1번 지역 판매 거점'), '남은 자리는 앞 항목부터 채운다');
  assert.ok(!itemLine.includes('11번'), '상한에 걸린 항목은 뺀다');
  assert.ok(block.charCount <= FACT_CARD_BLOCK_LIMIT_MAP.scale.maxChars);
});

test('둘째 카드의 머리 줄이 남은 자리에 들어가지 않으면 그 카드는 넣지 않는다', () => {
  const longItemList = Array.from({ length: 12 }, (_, index) => item(`거점 ${index + 1}`, `2023 ${1000 + index}, 2024 ${2000 + index}`));
  const block = buildFactCardBlock({ cardList: [{ ...chartCard, itemList: longItemList }, tableCard], usage: FACT_CARD_USAGE_MAP.value });
  assert.ok(block.charCount <= FACT_CARD_BLOCK_LIMIT_MAP.value.maxChars);
  const hasSecond = block.text.includes('[사실 2]');
  assert.equal(block.cardCount, hasSecond ? 2 : 1);
});

test('빈 칸은 줄에서 뺀다(종류·위치·기간·단위·구성 없음, 값 없는 항목은 이름만)', () => {
  const bare = { ...chartCard, kind: '', position: '', period: '', unit: '', axisList: [], legendList: [], count: 0,
    itemList: [item('서울', ''), item('', '410'), item('부산', '', '휴업')] };
  const block = buildFactCardBlock({ cardList: [bare], usage: FACT_CARD_USAGE_MAP.value });
  assert.deepEqual(block.text.split('\n').slice(3, -1), ['[사실 1] 「지역별 판매량」', '  서울 / 410 / 부산 (휴업)']);
});

test('빈 목록이면 빈 덩어리다', () => {
  for (const cardList of [[], undefined, null]) {
    for (const usage of Object.values(FACT_CARD_USAGE_MAP)) {
      assert.deepEqual(buildFactCardBlock({ cardList, usage }), { text: '', cardCount: 0, charCount: 0 });
    }
  }
});
