import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createFactCardTokenizer, filterFreshFactCards, selectFactCards, FACT_CARD_FRESH_MAP,
} = require('../src/main/caption-pipeline/orchestrator/fact-card-select.js');
const { createFactCardStore } = require('../src/main/caption-pipeline/orchestrator/fact-card-store.js');
const { FACT_CARD_USAGE_MAP } = require('../src/main/caption-pipeline/prompts/fact-card-block.js');

// 옛 슬라이드의 카드가 섞이지 않게 한다: 장(major)으로만 찾고, 해설 순간 같은 프레임 OCR 과 겹침이 낮은 카드와
// OCR 에 없는 값을 뺀다. 아래 화면은 모두 지어낸 예다.
const item = (label, value, note = '') => ({ label, value, note, isValueVerified: null });
const chartCard = {
  id: '3:1', kind: 'chart', title: '지역별 판매량', position: '왼쪽', period: '2023~2024', unit: '천 대',
  axisList: [], legendList: ['2023', '2024'], headerList: [],
  itemList: [item('서울', '2023 410, 2024 520'), item('부산', '2023 300, 2024 280'), item('대구', '2023 150, 2024 190')], count: 3,
};
const tableCard = {
  id: '3:2', kind: 'table', title: '채널별 비중', position: '오른쪽', period: '', unit: '%', axisList: [], legendList: [],
  headerList: ['채널', '2023', '2024'], itemList: [item('온라인', '2023 35%, 2024 48%'), item('오프라인', '2023 65%, 2024 52%')], count: 2,
};
const planCard = {
  id: '3:3', kind: 'list', title: '향후 계획', position: '아래', period: '', unit: '', axisList: [], legendList: [], headerList: [],
  itemList: [item('신규 매장', '12곳'), item('물류 센터', '2곳')], count: 2,
};
const line = (text, score = 0.95) => ({ text, score });
// 지금 화면에는 판매량 그래프와 채널 표만 있다(계획 목록은 사라졌다). 부산 2024 값은 280 이 아니라 295 로 바뀌었다.
const frameLineList = [
  line('2024 영업 요약'), line('지역별 판매량 (천 대)'), line('서울 410 520'), line('부산 300 295', 0.6),
  line('대구 150 190'), line('채널별 비중'), line('채널 2023 2024'), line('온라인 35% 48%'), line('오프라인 65% 52%'),
];
const tokenizer = createFactCardTokenizer();
const slideState = (cardList = [chartCard, tableCard, planCard], extra = {}) => ({
  status: 'ready', major: '3', screenTitle: '2024 영업 요약', frameTs: 1000, cardList, ...extra,
});

test('같은 프레임 OCR 과 낱말 겹침이 0.3 보다 낮은 카드는 지금 화면이 아니라고 보고 뺀다', () => {
  const result = filterFreshFactCards({ cardList: [chartCard, tableCard, planCard], frameLineList, tokenizer });
  assert.deepEqual(result.cardList.map((card) => card.id), ['3:1', '3:2']);
  assert.equal(result.fresh, FACT_CARD_FRESH_MAP.ok);
  assert.equal(result.staleDroppedCount, 1);
});

test('모든 카드가 빠지면 stale 로 남긴다', () => {
  const result = filterFreshFactCards({ cardList: [planCard], frameLineList, tokenizer });
  assert.deepEqual(result.cardList, []);
  assert.equal(result.fresh, FACT_CARD_FRESH_MAP.stale);
  assert.equal(result.staleDroppedCount, 1);
});

test('낱말이 3개보다 적은 카드는 겹침으로 가르지 않는다', () => {
  const shortCard = { ...planCard, id: '3:4', title: '요점', itemList: [item('정리', '')] };
  const result = filterFreshFactCards({ cardList: [shortCard], frameLineList, tokenizer });
  assert.deepEqual(result.cardList.map((card) => card.id), ['3:4']);
  assert.equal(result.fresh, FACT_CARD_FRESH_MAP.ok);
});

test('OCR 글자(점수와 상관없이 모든 줄)에 없는 숫자 값은 값만 비우고 항목 이름은 남긴다', () => {
  const result = filterFreshFactCards({ cardList: [chartCard, tableCard], frameLineList, tokenizer });
  const [chart] = result.cardList;
  assert.deepEqual(chart.itemList.map((entry) => [entry.label, entry.value]), [
    ['서울', '2023 410, 2024 520'], ['부산', ''], ['대구', '2023 150, 2024 190'],
  ]);
  assert.equal(chart.itemList[1].isValueVerified, false);
  assert.equal(result.valueDroppedCount, 1);
  assert.equal(chartCard.itemList[1].value, '2023 300, 2024 280', '저장된 카드는 바꾸지 않는다');
});

test('OCR 이 없거나 못 믿는 결과(빈 줄 목록)면 거르지 않고 unchecked 로 남긴다', () => {
  for (const emptyList of [[], undefined, null, [{ text: '' }]]) {
    const result = filterFreshFactCards({ cardList: [chartCard, planCard], frameLineList: emptyList, tokenizer });
    assert.deepEqual(result.cardList, [chartCard, planCard]);
    assert.equal(result.fresh, FACT_CARD_FRESH_MAP.unchecked);
    assert.equal(result.staleDroppedCount, 0);
    assert.equal(result.valueDroppedCount, 0);
  }
});

test('고를 때도 신선도를 따른다: 지금 화면에 없는 카드는 점수가 높아도 고르지 않는다', () => {
  const result = selectFactCards({
    state: slideState(), usage: FACT_CARD_USAGE_MAP.value, utterance: '향후 계획에서 신규 매장이 늘었습니다',
    anchorList: [], beforeText: '', frameLineList, requestTs: 5000, tokenizer,
  });
  assert.deepEqual(result.cardList, []);
  assert.equal(result.record.fresh, FACT_CARD_FRESH_MAP.ok);
  assert.equal(result.record.staleDroppedCount, 1);
  const withoutOcr = selectFactCards({
    state: slideState(), usage: FACT_CARD_USAGE_MAP.value, utterance: '향후 계획에서 신규 매장이 늘었습니다',
    anchorList: [], beforeText: '', frameLineList: [], requestTs: 5000, tokenizer,
  });
  assert.deepEqual(withoutOcr.cardList.map((card) => card.id), ['3:3']);
  assert.equal(withoutOcr.record.fresh, FACT_CARD_FRESH_MAP.unchecked);
});

test('고른 카드에 OCR 에 없는 값이 있으면 그 값은 비운 채로 넘기고 기록에 센다', () => {
  const result = selectFactCards({
    state: slideState(), usage: FACT_CARD_USAGE_MAP.value, utterance: '지역별 판매량 보시면',
    anchorList: [], beforeText: '', frameLineList, requestTs: 5000, tokenizer,
  });
  assert.deepEqual(result.cardList.map((card) => card.id), ['3:1']);
  assert.equal(result.cardList[0].itemList[1].value, '');
  assert.equal(result.record.valueDroppedCount, 1);
});

test('해설 요청 시각이 카드를 만든 프레임보다 앞서면 쓰지 않는다', () => {
  const result = selectFactCards({
    state: slideState(), usage: FACT_CARD_USAGE_MAP.value, utterance: '채널별 비중',
    anchorList: [], beforeText: '', frameLineList: [], requestTs: 999, tokenizer,
  });
  assert.deepEqual(result.cardList, []);
  assert.equal(result.record.skipReason, 'before_card_frame');
});

test('다른 장(major)의 카드는 절대 나오지 않는다', async () => {
  const otherMajor = selectFactCards({
    state: slideState([chartCard], { major: '4' }), usage: FACT_CARD_USAGE_MAP.value, utterance: '지역별 판매량',
    anchorList: [], beforeText: '', frameLineList: [], requestTs: 5000, tokenizer,
  });
  assert.deepEqual(otherMajor.cardList, []);
  assert.equal(otherMajor.record.cardCount, 0);
  const store = createFactCardStore({
    build: async ({ jpegBuffer }) => ({
      screenTitle: '', cardList: [{ ...chartCard, id: undefined, title: jpegBuffer.toString() }], isTruncated: false, rawLength: 1, jsonMode: 'prompt',
    }),
    slideTextStore: { waitFor: async () => {}, get: () => ({ status: 'failed', text: '' }) },
  });
  store.ensure({ slideLabel: '3', jpegBuffer: Buffer.from('지역별 판매량') });
  await store.waitUntil({ slideLabel: '3', untilPromise: new Promise(() => {}) });
  store.ensure({ slideLabel: '4', jpegBuffer: Buffer.from('채널별 비중') });
  const pendingState = await store.waitUntil({ slideLabel: '4-1', untilPromise: Promise.resolve() });
  const result = selectFactCards({
    state: pendingState, usage: FACT_CARD_USAGE_MAP.value, utterance: '지역별 판매량',
    anchorList: [], beforeText: '', frameLineList: [], requestTs: Date.now() + 1000, tokenizer,
  });
  assert.deepEqual(result.cardList, [], '4 장 카드가 아직이면 3 장 카드로 대신하지 않는다');
  const readyState = await store.waitUntil({ slideLabel: '4', untilPromise: new Promise(() => {}) });
  const ready = selectFactCards({
    state: readyState, usage: FACT_CARD_USAGE_MAP.value, utterance: '지역별 판매량',
    anchorList: [], beforeText: '', frameLineList: [], requestTs: Date.now() + 1000, tokenizer,
  });
  assert.deepEqual(ready.cardList.map((card) => card.id), ['4:1']);
});
