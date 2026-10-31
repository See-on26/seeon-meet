import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createFactCardTokenizer, buildFactCardQuery, scoreFactCardList, selectFactCards, resolveFactCardUsage, formatFactCardSummary,
  FACT_CARD_MIN_SCORE, FACT_CARD_RELATIVE_SCORE, FACT_CARD_DEIXIS_MIN_SCORE,
} = require('../src/main/caption-pipeline/orchestrator/fact-card-select.js');
const { FACT_CARD_USAGE_MAP } = require('../src/main/caption-pipeline/prompts/fact-card-block.js');
const { createKiwiTokenizer } = require('../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');

// Kiwi 형태소 분석이 있으면 명사·명사+접미사를 뽑는다(전사 줄 고르기의 조사 떼기보다 정확하다).
const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
let kiwiTokenizer = null;
before(async () => {
  if (!hasKiwiModel) return;
  kiwiTokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await kiwiTokenizer.load();
});

// 해설 순간 발표자가 부른 이름·숫자가 적힌 패널의 카드를 고른다. 아래 화면은 모두 지어낸 예다.
const item = (label, value, note = '') => ({ label, value, note, isValueVerified: null });
const chartCard = {
  id: '3:1', kind: 'chart', title: '지역별 판매량', position: '왼쪽', period: '2023~2024', unit: '천 대',
  axisList: [{ name: '지역', from: '서울', to: '강원' }, { name: '판매량', from: '0', to: '800' }], legendList: ['2023', '2024'], headerList: [],
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
const slideState = (cardList = [chartCard, tableCard, planCard], extra = {}) => ({
  status: 'ready', major: '3', screenTitle: '2024 영업 요약', frameTs: 1000, cardList, ...extra,
});
const tokenizer = createFactCardTokenizer();
const select = ({ usage = FACT_CARD_USAGE_MAP.value, state = slideState(), ...option }) => selectFactCards({
  state, usage, utterance: '', anchorList: [], beforeText: '', frameLineList: [], requestTs: 5000, tokenizer, ...option,
});
const selectedIdOf = (result) => result.cardList.map((card) => card.id);
const scoreOf = (result, id) => result.record.scoreList.find((entry) => entry.id === id)?.score;

test('점수 시작값: 고르기 문턱 2, 최고점의 0.5, 지시는 3', () => {
  assert.equal(FACT_CARD_MIN_SCORE, 2);
  assert.equal(FACT_CARD_RELATIVE_SCORE, 0.5);
  assert.equal(FACT_CARD_DEIXIS_MIN_SCORE, 3);
});

test('세 카드 중 발화 명사가 제목에 든 카드를 고른다', () => {
  const result = select({ utterance: '채널별 비중이 많이 바뀌었습니다' });
  assert.deepEqual(selectedIdOf(result), ['3:2']);
  assert.equal(result.record.status, 'ready');
  assert.equal(result.record.cardCount, 3);
  assert.deepEqual(result.record.selectedIdList, ['3:2']);
  assert.ok(scoreOf(result, '3:2') >= 6);
  assert.equal(scoreOf(result, '3:1'), 0);
});

test('숫자가 맞는 카드는 모든 카드에 나오는 낱말(화면 제목)보다 세게 친다', () => {
  const result = select({ utterance: '영업 요약에서 48이라는 숫자가 중요합니다' });
  assert.deepEqual(selectedIdOf(result), ['3:2']);
  assert.equal(scoreOf(result, '3:1'), 2, '화면 제목 낱말 둘 × 3 × 1/3');
  assert.equal(scoreOf(result, '3:2'), 5, '+ 숫자 48 맞춤 3');
});

test('모든 카드에 나오는 낱말은 가르는 힘이 약하다(idf)', () => {
  const scoreList = scoreFactCardList({
    cardList: [chartCard, tableCard, planCard], screenTitle: '2024 영업 요약',
    query: buildFactCardQuery({ utterance: '요약 보시면', tokenizer }), tokenizer,
  });
  assert.deepEqual(scoreList.map((entry) => entry.score), [1, 1, 1]);
  const uniqueList = scoreFactCardList({
    cardList: [chartCard, tableCard, planCard], screenTitle: '2024 영업 요약',
    query: buildFactCardQuery({ utterance: '계획 보시면', tokenizer }), tokenizer,
  });
  assert.deepEqual(uniqueList.map((entry) => entry.score), [0, 0, 3]);
  assert.deepEqual(selectedIdOf(select({ utterance: '요약 보시면' })), []);
});

test('문턱 미만이면 빈 목록이다', () => {
  const result = select({ utterance: '그렇습니다 정말 그렇네요' });
  assert.deepEqual(result.cardList, []);
  assert.deepEqual(result.record.selectedIdList, []);
});

test('장수 상한: 수치 2장·척도 1장·지시 1장, 점수 순서', () => {
  const utterance = '지역별 판매량, 채널별 비중, 향후 계획 모두 보시면';
  assert.deepEqual(selectedIdOf(select({ utterance })), ['3:1', '3:2']);
  assert.deepEqual(selectedIdOf(select({ utterance, usage: FACT_CARD_USAGE_MAP.scale })), ['3:1']);
  assert.deepEqual(selectedIdOf(select({ utterance, usage: FACT_CARD_USAGE_MAP.deixis })), ['3:1']);
});

test('최고점의 절반보다 낮은 카드는 뺀다', () => {
  const result = select({ utterance: '지역별 판매량 가운데 서울 그리고 향후' });
  assert.ok(scoreOf(result, '3:3') >= 2);
  assert.ok(scoreOf(result, '3:3') < scoreOf(result, '3:1') * 0.5);
  assert.deepEqual(selectedIdOf(result), ['3:1']);
});

test('카드가 1장뿐인 슬라이드는 수치·척도에 점수 없이도 넘기고, 지시에는 넘기지 않는다', () => {
  const state = slideState([chartCard]);
  assert.deepEqual(selectedIdOf(select({ state, utterance: '그렇습니다' })), ['3:1']);
  assert.deepEqual(selectedIdOf(select({ state, utterance: '그렇습니다', usage: FACT_CARD_USAGE_MAP.scale })), ['3:1']);
  assert.deepEqual(selectedIdOf(select({ state, utterance: '그렇습니다', usage: FACT_CARD_USAGE_MAP.deixis })), []);
});

test('지시는 숫자만 맞으면 주지 않는다(이름이 맞아야 한다)', () => {
  const utterance = '48 이 숫자가 중요합니다';
  assert.deepEqual(selectedIdOf(select({ utterance })), ['3:2']);
  assert.deepEqual(selectedIdOf(select({ utterance, usage: FACT_CARD_USAGE_MAP.deixis })), []);
  assert.deepEqual(selectedIdOf(select({ utterance: '여기 채널별 비중 보시면', usage: FACT_CARD_USAGE_MAP.deixis })), ['3:2']);
});

test('앞 발화(끝 80자)의 낱말은 0.5배로 친다. 발화에 이미 있는 낱말은 두 번 세지 않는다', () => {
  const contextOnly = select({ utterance: '이게 정말 중요합니다', beforeText: '앞에서 말씀드린 비중' });
  assert.equal(scoreOf(contextOnly, '3:2'), 1.5);
  assert.deepEqual(selectedIdOf(contextOnly), []);
  assert.equal(scoreOf(select({ utterance: '비중 보시면' }), '3:2'), 3);
  assert.equal(scoreOf(select({ utterance: '비중 보시면', beforeText: '앞에서 말씀드린 비중' }), '3:2'), 3);
  const farContext = select({ utterance: '이게 정말 중요합니다', beforeText: `비중 ${'그리고 '.repeat(30)}` });
  assert.equal(scoreOf(farContext, '3:2'), 0, '끝 80자 밖의 낱말은 보지 않는다');
});

test('판단 LLM 이 고른 근거 표현(지시 구·합쳐진 변화 구)도 발화와 같이 본다', () => {
  const result = select({ utterance: '이게 크게 늘었습니다', anchorList: ['향후 계획'] });
  assert.deepEqual(selectedIdOf(result), ['3:3']);
});

test('Kiwi 가 없으면 조사를 뗀 낱말로 맞춘다', () => {
  const notReady = createFactCardTokenizer({ kiwiTokenizer: { isReady: () => false, tokenize: () => null } });
  assert.ok(notReady.extractWordList('채널별로 보면').includes('채널별'));
  const result = selectFactCards({
    state: slideState(), usage: FACT_CARD_USAGE_MAP.value, utterance: '채널별로 보면 비중이', anchorList: [],
    beforeText: '', frameLineList: [], requestTs: 5000, tokenizer: notReady,
  });
  assert.deepEqual(selectedIdOf(result), ['3:2']);
});

test('같은 글자는 한 번만 분석하고, Kiwi 가 뒤늦게 준비되면 Kiwi 로 다시 분석한다', () => {
  let isReady = false;
  let callCount = 0;
  const kiwiStub = {
    isReady: () => isReady,
    tokenize: () => { callCount += 1; return [{ form: '판매', tag: 'NNG', start: 0, end: 2 }, { form: '량', tag: 'XSN', start: 2, end: 3 }]; },
  };
  const cachedTokenizer = createFactCardTokenizer({ kiwiTokenizer: kiwiStub });
  assert.deepEqual(cachedTokenizer.extractWordList('판매량이'), ['판매량'], '준비 전에는 조사 떼기');
  isReady = true;
  assert.deepEqual(cachedTokenizer.extractWordList('판매량이'), ['판매', '판매량']);
  cachedTokenizer.extractWordList('판매량이');
  assert.equal(callCount, 1);
});

test('영어 발화도 같은 방법으로 고른다(대소문자 무시)', () => {
  const englishState = slideState([
    { ...tableCard, id: '3:1', title: 'Channel Share', headerList: [], itemList: [item('Online', '48%'), item('Offline', '52%')] },
    { ...chartCard, id: '3:2', title: 'Regional Sales', axisList: [], itemList: [item('Seoul', '520')] },
  ], { screenTitle: 'Q3 Review' });
  const result = select({ state: englishState, utterance: 'The online share jumped a lot' });
  assert.deepEqual(selectedIdOf(result), ['3:1']);
});

test('발화가 맞힌 항목을 표시해 덩어리가 그 항목부터 담게 한다', () => {
  const [card] = select({ utterance: '지역별 판매량에서 부산은 줄었습니다' }).cardList;
  assert.equal(card.id, '3:1');
  assert.deepEqual(card.matchedItemIndexList, [1]);
  const [numberCard] = select({ utterance: '채널별로 보면 52 정도' }).cardList;
  assert.deepEqual(numberCard.matchedItemIndexList, [1]);
});

test('카드가 준비되지 않았으면 고르지 않고 상태만 기록한다', () => {
  for (const status of ['missing', 'pending', 'none', 'failed', 'skipped']) {
    const result = select({ state: { status, major: '3', screenTitle: '', frameTs: null, cardList: [] }, utterance: '채널별 비중' });
    assert.deepEqual(result.cardList, []);
    assert.equal(result.record.status, status);
    assert.equal(result.record.cardCount, 0);
  }
});

test('어느 에이전트가 카드를 받나: 꺼져 있으면 아무도, 기본은 수치·척도, 지시는 목록에 있을 때만', () => {
  const defaultList = ['interpretation', 'scale'];
  assert.equal(resolveFactCardUsage({ narrationType: 'interpretation', isEnabled: false, agentList: defaultList }), null);
  assert.equal(resolveFactCardUsage({ narrationType: 'interpretation', isEnabled: true, agentList: defaultList }), FACT_CARD_USAGE_MAP.value);
  assert.equal(resolveFactCardUsage({ narrationType: 'visual_description', subKind: 'scale', isEnabled: true, agentList: defaultList }), FACT_CARD_USAGE_MAP.scale);
  assert.equal(resolveFactCardUsage({ narrationType: 'visual_description', subKind: null, isEnabled: true, agentList: defaultList }), FACT_CARD_USAGE_MAP.scale);
  assert.equal(resolveFactCardUsage({ narrationType: 'visual_description', subKind: 'reaction', isEnabled: true, agentList: defaultList }), null);
  assert.equal(resolveFactCardUsage({ narrationType: 'deixis', isEnabled: true, agentList: defaultList }), null);
  assert.equal(resolveFactCardUsage({ narrationType: 'deixis', isEnabled: true, agentList: [...defaultList, 'deixis'] }), FACT_CARD_USAGE_MAP.deixis);
  assert.equal(resolveFactCardUsage({ narrationType: 'interpretation', isEnabled: true, agentList: ['deixis'] }), null);
  assert.equal(resolveFactCardUsage({ narrationType: 'user_command', isEnabled: true, agentList: defaultList }), null);
});

test('기록 요약: 고른 장수/전체·글자 수·신선도·대기 시간', () => {
  assert.equal(formatFactCardSummary({
    status: 'ready', cardCount: 5, selectedIdList: ['3:1', '3:2'], charCount: 312, fresh: 'ok', waitedMs: 0,
  }), '사실 카드=2/5장 312자 fresh=ok 대기 0ms');
  assert.equal(formatFactCardSummary({
    status: 'pending', cardCount: 0, selectedIdList: [], charCount: 0, fresh: 'unchecked', waitedMs: 1000,
  }), '사실 카드=없음(pending, 대기 1000ms)');
  assert.equal(formatFactCardSummary({
    status: 'ready', cardCount: 3, selectedIdList: [], charCount: 0, fresh: 'stale', waitedMs: 12, skipReason: null,
  }), '사실 카드=0/3장 0자 fresh=stale 대기 12ms');
});

test('Kiwi: 명사와 붙어 있는 명사+접미사를 함께 뽑고, 영어는 소문자로, 술어는 뽑지 않는다', { skip: !hasKiwiModel }, () => {
  const kiwi = createFactCardTokenizer({ kiwiTokenizer });
  const wordList = kiwi.extractWordList('지역별 판매량이 서울에서 크게 늘었습니다');
  for (const word of ['지역', '지역별', '판매량', '서울']) assert.ok(wordList.includes(word), word);
  for (const word of ['늘었습니다', '크게', '판매량이']) assert.ok(!wordList.includes(word), word);
  assert.ok(kiwi.extractWordList('Online share 영업이익률').includes('online'));
  assert.ok(kiwi.extractWordList('Online share 영업이익률').includes('영업이익률'));
  assert.deepEqual(kiwi.extractNumberCoreList('매출 2,318억 원과 3분기'), ['2318']);
  const result = selectFactCards({
    state: slideState(), usage: FACT_CARD_USAGE_MAP.value, utterance: '판매량이 지역마다 크게 달랐습니다', anchorList: [],
    beforeText: '', frameLineList: [], requestTs: 5000, tokenizer: kiwi,
  });
  assert.deepEqual(selectedIdOf(result), ['3:1']);
});
