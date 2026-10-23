import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFactCardStore, FACT_CARD_STATUS_MAP } = require('../src/main/caption-pipeline/orchestrator/fact-card-store.js');

// 카드 만들기는 동시에 하나만 돈다. 도는 중에 새 장이 오면 가장 최근 것만 기다리게 하고, 밀려난 장은 건너뛴다.
const titledCard = (title) => ({
  kind: 'chart', title, position: '', period: '', unit: '', axisList: [], legendList: [], headerList: [],
  itemList: [{ label: '서울', value: '410', note: '' }], count: 1,
});
const builtOf = (cardList, extra = {}) => ({
  screenTitle: '국내 판매 현황', cardList, isTruncated: false, rawLength: 321, jsonMode: 'prompt', ...extra,
});
const readySlideTextStore = (text = '서울 410') => ({ waitFor: async () => {}, get: () => ({ status: 'ready', text }) });
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

function createDeferredBuild() {
  const callList = [];
  const build = ({ jpegBuffer }) => new Promise((resolve, reject) => {
    callList.push({ name: jpegBuffer.toString(), resolve, reject });
  });
  return { build, callList };
}

test('장(major)마다 한 번만 만든다("3"·"3-1" 은 같은 장)', async () => {
  let callCount = 0;
  const store = createFactCardStore({
    build: async () => { callCount += 1; return builtOf([titledCard('지역별 판매량')]); },
    slideTextStore: readySlideTextStore(),
  });
  assert.equal(store.ensure({ slideLabel: '3', jpegBuffer: Buffer.from('a') }), true);
  assert.equal(store.ensure({ slideLabel: '3-1', jpegBuffer: Buffer.from('b') }), false);
  await store.waitUntil({ slideLabel: '3', untilPromise: new Promise(() => {}) });
  assert.equal(callCount, 1);
  const state = store.get('3-2');
  assert.equal(state.status, FACT_CARD_STATUS_MAP.ready);
  assert.equal(state.major, '3');
  assert.deepEqual(state.cardList.map((card) => card.id), ['3:1']);
  assert.equal(state.screenTitle, '국내 판매 현황');
});

test('요청 전은 missing, 만드는 중은 pending, 끝나면 ready·none·failed', async () => {
  const store = createFactCardStore({
    build: async ({ jpegBuffer }) => {
      const name = jpegBuffer.toString();
      if (name === 'fail') throw new Error('VLM(사실카드) HTTP 500');
      return builtOf(name === 'photo' ? [] : [titledCard('지역별 판매량'), titledCard('채널별 비중')]);
    },
    slideTextStore: readySlideTextStore(),
  });
  assert.equal(store.get('1').status, FACT_CARD_STATUS_MAP.missing);
  assert.deepEqual(store.get('1').cardList, []);
  store.ensure({ slideLabel: '1', jpegBuffer: Buffer.from('chart') });
  assert.equal(store.get('1').status, FACT_CARD_STATUS_MAP.pending);
  await store.waitUntil({ slideLabel: '1', untilPromise: new Promise(() => {}) });
  assert.equal(store.get('1').status, FACT_CARD_STATUS_MAP.ready);
  assert.deepEqual(store.get('1').cardList.map((card) => card.id), ['1:1', '1:2']);
  store.ensure({ slideLabel: '2', jpegBuffer: Buffer.from('photo') });
  await store.waitUntil({ slideLabel: '2', untilPromise: new Promise(() => {}) });
  assert.equal(store.get('2').status, FACT_CARD_STATUS_MAP.none);
  store.ensure({ slideLabel: '4', jpegBuffer: Buffer.from('fail') });
  await store.waitUntil({ slideLabel: '4', untilPromise: new Promise(() => {}) });
  assert.equal(store.get('4').status, FACT_CARD_STATUS_MAP.failed);
});

test('동시에 하나만: 세 장이 연달아 오면 가운데 장은 건너뛰고(skipped) 가장 최근 장을 다음에 만든다', async () => {
  const { build, callList } = createDeferredBuild();
  const settledList = [];
  const store = createFactCardStore({ build, slideTextStore: readySlideTextStore(), onSettled: (event) => settledList.push(event) });
  store.ensure({ slideLabel: '1', jpegBuffer: Buffer.from('1') });
  store.ensure({ slideLabel: '2', jpegBuffer: Buffer.from('2') });
  store.ensure({ slideLabel: '3', jpegBuffer: Buffer.from('3') });
  await flush();
  assert.deepEqual(callList.map((call) => call.name), ['1']);
  assert.equal(store.get('2').status, FACT_CARD_STATUS_MAP.skipped);
  assert.equal(store.get('3').status, FACT_CARD_STATUS_MAP.pending);
  assert.deepEqual(settledList.map((event) => [event.slideLabel, event.status]), [['2', 'skipped']]);
  callList[0].resolve(builtOf([titledCard('A')]));
  await flush();
  assert.deepEqual(callList.map((call) => call.name), ['1', '3'], '앞 장이 끝나야 다음 장을 부른다');
  callList[1].resolve(builtOf([titledCard('C')]));
  await flush();
  assert.equal(store.get('3').status, FACT_CARD_STATUS_MAP.ready);
  assert.deepEqual(settledList.map((event) => [event.slideLabel, event.status]), [['2', 'skipped'], ['1', 'ready'], ['3', 'ready']]);
});

test('실패·건너뛴 장은 다시 만들기를 한 번만 한다(복귀 때). 준비된 장과 처음 보는 장은 다시 만들지 않는다', async () => {
  let callCount = 0;
  const store = createFactCardStore({
    build: async () => { callCount += 1; throw new Error('시간 초과'); },
    slideTextStore: readySlideTextStore(),
  });
  store.ensure({ slideLabel: '5', jpegBuffer: Buffer.from('x') });
  await flush();
  assert.equal(store.get('5').status, FACT_CARD_STATUS_MAP.failed);
  assert.equal(store.ensure({ slideLabel: '5', jpegBuffer: Buffer.from('x') }), false, '재시도 표시 없이는 다시 만들지 않는다');
  assert.equal(store.ensure({ slideLabel: '5', jpegBuffer: Buffer.from('x'), isRetry: true }), true);
  await flush();
  assert.equal(callCount, 2);
  assert.equal(store.ensure({ slideLabel: '5', jpegBuffer: Buffer.from('x'), isRetry: true }), false, '한 번만');
  assert.equal(store.ensure({ slideLabel: '9', jpegBuffer: Buffer.from('x'), isRetry: true }), false, '처음 보는 장');
  const readyStore = createFactCardStore({ build: async () => builtOf([titledCard('A')]), slideTextStore: readySlideTextStore() });
  readyStore.ensure({ slideLabel: '6', jpegBuffer: Buffer.from('x') });
  await flush();
  assert.equal(readyStore.ensure({ slideLabel: '6', jpegBuffer: Buffer.from('x'), isRetry: true }), false);
});

test('건너뛴 장도 복귀 때 한 번 다시 만든다', async () => {
  const { build, callList } = createDeferredBuild();
  const store = createFactCardStore({ build, slideTextStore: readySlideTextStore() });
  store.ensure({ slideLabel: '1', jpegBuffer: Buffer.from('1') });
  store.ensure({ slideLabel: '2', jpegBuffer: Buffer.from('2') });
  store.ensure({ slideLabel: '3', jpegBuffer: Buffer.from('3') });
  assert.equal(store.get('2').status, FACT_CARD_STATUS_MAP.skipped);
  assert.equal(store.ensure({ slideLabel: '2', jpegBuffer: Buffer.from('2again'), isRetry: true }), true);
  assert.equal(store.get('3').status, FACT_CARD_STATUS_MAP.skipped, '다시 만들 장이 가장 최근 것이 된다');
  await flush();
  callList[0].resolve(builtOf([titledCard('A')]));
  await flush();
  assert.deepEqual(callList.map((call) => call.name), ['1', '2again']);
});

test('세션 초기화 뒤에는 앞 세션의 늦은 결과를 버리고, 그 호출이 끝날 때까지 새 호출을 겹쳐 부르지 않는다', async () => {
  const { build, callList } = createDeferredBuild();
  const settledList = [];
  const store = createFactCardStore({ build, slideTextStore: readySlideTextStore(), onSettled: (event) => settledList.push(event) });
  store.ensure({ slideLabel: '1', jpegBuffer: Buffer.from('old') });
  store.reset();
  assert.equal(store.get('1').status, FACT_CARD_STATUS_MAP.missing);
  store.ensure({ slideLabel: '1', jpegBuffer: Buffer.from('new') });
  await flush();
  assert.deepEqual(callList.map((call) => call.name), ['old']);
  callList[0].resolve(builtOf([titledCard('옛 화면')]));
  await flush();
  assert.equal(store.get('1').status, FACT_CARD_STATUS_MAP.pending, '옛 결과를 새 세션의 같은 번호 장에 붙이지 않는다');
  assert.deepEqual(callList.map((call) => call.name), ['old', 'new']);
  callList[1].resolve(builtOf([titledCard('새 화면')]));
  await flush();
  assert.equal(store.get('1').cardList[0].title, '새 화면');
  assert.deepEqual(settledList.map((event) => event.cardList[0]?.title), ['새 화면']);
});

test('waitUntil: 카드가 먼저 끝나면 ready, 함께 기다린 일이 먼저 끝나면 pending 으로 돌아온다. 기다릴 일이 없으면 바로 돌아온다', async () => {
  const { build, callList } = createDeferredBuild();
  const store = createFactCardStore({ build, slideTextStore: readySlideTextStore() });
  store.ensure({ slideLabel: '7', jpegBuffer: Buffer.from('7') });
  const noWait = await store.waitUntil({ slideLabel: '7', untilPromise: null });
  assert.equal(noWait.status, FACT_CARD_STATUS_MAP.pending);
  const early = await store.waitUntil({ slideLabel: '7', untilPromise: Promise.resolve() });
  assert.equal(early.status, FACT_CARD_STATUS_MAP.pending);
  assert.ok(Number.isFinite(early.waitedMs));
  const waiting = store.waitUntil({ slideLabel: '7', untilPromise: new Promise(() => {}) });
  callList[0].resolve(builtOf([titledCard('A')]));
  assert.equal((await waiting).status, FACT_CARD_STATUS_MAP.ready);
  const missing = await store.waitUntil({ slideLabel: '8', untilPromise: new Promise(() => {}) });
  assert.equal(missing.status, FACT_CARD_STATUS_MAP.missing);
});

test('카드를 꺼 두면 아무것도 부르지 않는다', async () => {
  let callCount = 0;
  const store = createFactCardStore({
    build: async () => { callCount += 1; return builtOf([titledCard('A')]); },
    slideTextStore: readySlideTextStore(), isEnabled: () => false,
  });
  assert.equal(store.ensure({ slideLabel: '1', jpegBuffer: Buffer.from('x') }), false);
  await flush();
  assert.equal(callCount, 0);
  assert.equal(store.get('1').status, FACT_CARD_STATUS_MAP.missing);
});

test('끝나면 기록할 것을 알린다: 걸린 시간·대기 시간·장수·카드 전체·검증 출처와 비운 값 수', async () => {
  let nowMs = 1000;
  const settledList = [];
  const store = createFactCardStore({
    build: async () => {
      nowMs = 3400;
      return builtOf([{ ...titledCard('지역별 판매량'), itemList: [{ label: '서울', value: '410', note: '' }, { label: '부산', value: '999', note: '' }] }]);
    },
    slideTextStore: readySlideTextStore('서울 410 부산 300'),
    readSlideTextSource: (major) => (major === '3' ? 'ocr' : null),
    onSettled: (event) => settledList.push(event),
    now: () => nowMs,
  });
  store.ensure({ slideLabel: '3-1', jpegBuffer: Buffer.from('x') });
  await flush();
  assert.equal(settledList.length, 1);
  const [event] = settledList;
  assert.equal(event.slideLabel, '3');
  assert.equal(event.status, 'ready');
  assert.equal(event.frameTs, 1000);
  assert.equal(event.elapsedMs, 2400);
  assert.equal(event.queuedMs, 0);
  assert.equal(event.screenTitle, '국내 판매 현황');
  assert.equal(event.cardList.length, 1);
  assert.deepEqual(event.cardList[0].itemList.map((entry) => entry.value), ['410', '']);
  assert.deepEqual(event.verify, { source: 'slide_text_ocr', slideTextStatus: 'ready', checkedValueCount: 2, droppedValueCount: 1 });
  assert.equal(event.jsonMode, 'prompt');
  assert.equal(event.rawLength, 321);
  assert.equal(event.isTruncated, false);
  assert.equal(event.isRetry, false);
  assert.equal(store.get('3').frameTs, 1000);
});

test('카드 값 검증은 같은 장의 전사가 끝나기를 기다린 뒤 한다', async () => {
  let releaseSlideText;
  let slideText = { status: 'pending', text: '' };
  const slideTextStore = {
    waitFor: () => new Promise((resolve) => { releaseSlideText = () => { slideText = { status: 'ready', text: '서울 410' }; resolve(); }; }),
    get: () => slideText,
  };
  const store = createFactCardStore({ build: async () => builtOf([titledCard('A')]), slideTextStore });
  store.ensure({ slideLabel: '2', jpegBuffer: Buffer.from('x') });
  await flush();
  assert.equal(store.get('2').status, FACT_CARD_STATUS_MAP.pending);
  releaseSlideText();
  await flush();
  assert.equal(store.get('2').status, FACT_CARD_STATUS_MAP.ready);
  assert.equal(store.get('2').cardList[0].itemList[0].isValueVerified, true);
});
