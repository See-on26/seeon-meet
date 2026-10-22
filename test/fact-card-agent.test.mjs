import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createFactCardAgent, parseFactCardResponse, normalizeFactCardList, FACT_CARD_LIMIT_MAP, FACT_CARD_MAX_TOKENS,
} = require('../src/main/caption-pipeline/agents/fact-card-agent.js');
const { buildFactCardPrompt } = require('../src/main/caption-pipeline/prompts/fact-card.js');

// 새 슬라이드가 확정될 때 VLM 한 번으로 화면을 패널별 사실 카드(JSON)로 정리한다. 아래 화면은 모두 지어낸 예다.
const chartCard = {
  kind: 'chart', title: '지역별 판매량', position: '왼쪽', period: '2023~2024', unit: '천 대',
  axisList: [{ name: '지역', from: '서울', to: '강원' }, { name: '판매량', from: '0', to: '800' }],
  legendList: ['2023', '2024'], headerList: [],
  itemList: [{ label: '서울', value: '2023 410, 2024 520', note: '' }, { label: '부산', value: '2023 300, 2024 280', note: '' }],
  itemCount: 5,
};
const tableCard = {
  kind: 'table', title: '채널별 비중', position: '오른쪽', period: '', unit: '%', axisList: [], legendList: [],
  headerList: ['채널', '2023', '2024'], itemList: [{ label: '온라인', value: '2023 35%, 2024 48%', note: '추정치' }], itemCount: 1,
};
const listCard = {
  kind: 'list', title: '향후 계획', position: '아래', period: '', unit: '', axisList: [], legendList: [], headerList: [],
  itemList: [{ label: '신규 매장', value: '12곳', note: '' }], itemCount: 1,
};
const response = { screenTitle: '국내 판매 현황', cardList: [chartCard, tableCard] };

const expectedChart = {
  kind: 'chart', title: '지역별 판매량', position: '왼쪽', period: '2023~2024', unit: '천 대',
  axisList: [{ name: '지역', from: '서울', to: '강원' }, { name: '판매량', from: '0', to: '800' }],
  legendList: ['2023', '2024'], headerList: [],
  itemList: [{ label: '서울', value: '2023 410, 2024 520', note: '' }, { label: '부산', value: '2023 300, 2024 280', note: '' }],
  count: 2,
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
});

function installFetch({ content = JSON.stringify(response), status = 200 } = {}) {
  const bodyList = [];
  globalThis.fetch = async (_url, init) => {
    bodyList.push(JSON.parse(init.body));
    return { ok: status < 400, status, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return bodyList;
}

const config = { vlmUrl: 'http://x', vlmModel: 'm', factCardJsonMode: 'prompt' };

test('정상 JSON: 화면 제목과 카드를 그대로 옮기고, 개수는 옮긴 항목 수로 센다(VLM 이 센 수를 믿지 않음)', () => {
  const parsed = parseFactCardResponse(JSON.stringify(response));
  assert.equal(parsed.screenTitle, '국내 판매 현황');
  assert.equal(parsed.isTruncated, false);
  const cardList = normalizeFactCardList(parsed.cardList);
  assert.deepEqual(cardList[0], expectedChart);
  assert.equal(cardList[1].title, '채널별 비중');
  assert.deepEqual(cardList[1].headerList, ['채널', '2023', '2024']);
  assert.equal(cardList[1].itemList[0].note, '추정치');
  assert.equal(cardList[1].count, 1);
});

test('코드펜스와 앞뒤 설명 문장을 걷어 낸다', () => {
  const json = JSON.stringify(response);
  for (const content of [
    `\`\`\`json\n${json}\n\`\`\``,
    `다음은 사실 카드입니다.\n${json}\n이상입니다. {끝}`,
    `\`\`\`\n${json}\n\`\`\`\n추가 설명`,
  ]) {
    const parsed = parseFactCardResponse(content);
    assert.ok(parsed, content.slice(0, 20));
    assert.equal(parsed.isTruncated, false);
    assert.deepEqual(normalizeFactCardList(parsed.cardList)[0], expectedChart);
  }
});

test('출력 상한에서 잘린 JSON 은 마지막으로 닫힌 카드까지만 살린다', () => {
  const json = JSON.stringify({ screenTitle: '국내 판매 현황', cardList: [chartCard, tableCard, listCard] });
  const cutInThird = json.slice(0, json.indexOf('"향후 계획"') + 4);
  const parsed = parseFactCardResponse(cutInThird);
  assert.equal(parsed.isTruncated, true);
  assert.equal(parsed.screenTitle, '국내 판매 현황');
  assert.deepEqual(normalizeFactCardList(parsed.cardList).map((card) => card.title), ['지역별 판매량', '채널별 비중']);
  // 둘째 카드 안에서 잘리면 첫 카드만, 첫 카드 안에서 잘리면 살릴 것이 없다.
  const cutInSecond = json.slice(0, json.indexOf('"채널별 비중"') + 3);
  assert.deepEqual(parseFactCardResponse(cutInSecond).cardList.map((card) => card.title), ['지역별 판매량']);
  assert.equal(parseFactCardResponse(json.slice(0, json.indexOf('"부산"'))), null);
  // 따옴표 안의 괄호는 카드 경계로 보지 않는다.
  const braceInString = JSON.stringify({ screenTitle: '', cardList: [{ ...listCard, title: '계획 {초안}' }, chartCard] });
  const cutBrace = braceInString.slice(0, braceInString.indexOf('"부산"'));
  assert.deepEqual(parseFactCardResponse(cutBrace).cardList.map((card) => card.title), ['계획 {초안}']);
});

test('빈 카드 목록은 그대로 빈 목록이고, JSON 이 아니거나 cardList 가 없으면 해석 실패(null)', () => {
  assert.deepEqual(parseFactCardResponse('{"screenTitle":"","cardList":[]}'), { screenTitle: '', cardList: [], isTruncated: false });
  for (const content of ['NONE', '사진만 있는 화면입니다', '', null, undefined, '{"screenTitle":"제목"}', '{"cardList":"없음"}', '[1,2]']) {
    assert.equal(parseFactCardResponse(content), null, String(content));
  }
});

test('문자열이 아닌 칸·빈 항목·빈 카드는 버린다', () => {
  const cardList = normalizeFactCardList([
    'x', null, [],
    { kind: 'chart', title: 123, legendList: ['2023', 5, null, ' ', '2024'], headerList: 'a|b', axisList: [{ name: 7 }, { name: '연도', from: 2019, to: '2024' }],
      itemList: [{ label: 7, value: '' }, { label: '서울', value: 410 }, null, { label: '', value: '12곳', note: 3 }] },
    { kind: 'table', title: '', position: '왼쪽', itemList: [], axisList: [], legendList: [], headerList: [] },
    { kind: 'bar chart', title: '요약' },
  ]);
  assert.equal(cardList.length, 2);
  assert.deepEqual(cardList[0], {
    kind: 'chart', title: '', position: '', period: '', unit: '',
    axisList: [{ name: '연도', from: '', to: '2024' }], legendList: ['2023', '2024'], headerList: [],
    itemList: [{ label: '서울', value: '', note: '' }, { label: '', value: '12곳', note: '' }], count: 2,
  });
  assert.equal(cardList[1].kind, '', '정해진 종류가 아니면 비운다');
  assert.equal(cardList[1].title, '요약');
});

test('상한으로 자른다: 카드 6장·항목 12개·범례·머리글 8개·축 2개·글자 칸 40자', () => {
  assert.deepEqual(FACT_CARD_LIMIT_MAP, { cardCount: 6, itemCount: 12, legendCount: 8, headerCount: 8, axisCount: 2, fieldChars: 40 });
  const manyItem = Array.from({ length: 15 }, (_, index) => ({ label: `항목${index + 1}`, value: `${index + 10}`, note: '' }));
  const card = {
    kind: 'chart', title: '가'.repeat(60), itemList: manyItem,
    legendList: Array.from({ length: 10 }, (_, index) => `계열${index}`), headerList: Array.from({ length: 10 }, (_, index) => `칸${index}`),
    axisList: [{ name: 'x' }, { name: 'y' }, { name: 'z' }],
  };
  const cardList = normalizeFactCardList(Array.from({ length: 8 }, () => card));
  assert.equal(cardList.length, 6);
  assert.equal(cardList[0].itemList.length, 12);
  assert.equal(cardList[0].legendList.length, 8);
  assert.equal(cardList[0].headerList.length, 8);
  assert.equal(cardList[0].axisList.length, 2);
  assert.equal(cardList[0].title, '가'.repeat(40));
});

test('글자 칸을 자를 때 숫자 가운데서 끊지 않는다(잘린 숫자는 다른 값이 된다)', () => {
  const [card] = normalizeFactCardList([{ title: '표', itemList: [
    { label: '합계', value: `${'가'.repeat(37)} 1234`, note: '' },
    { label: '비율', value: `${'나'.repeat(36)} 12.75%`, note: '' },
    { label: '짧음', value: '  2023   410  ', note: '' },
  ] }]);
  assert.equal(card.itemList[0].value, '가'.repeat(37));
  assert.equal(card.itemList[1].value, '나'.repeat(36));
  assert.equal(card.itemList[2].value, '2023 410', '공백은 하나로 줄인다');
});

test('개수: 항목이 상한보다 적으면 그 수, 상한에 닿으면 VLM 이 센 수(상한 이상일 때만), 그 밖에는 비운다', () => {
  const makeItemList = (length) => Array.from({ length }, (_, index) => ({ label: `행${index}`, value: '', note: '' }));
  const countOf = (length, itemCount) => normalizeFactCardList([{ title: '표', itemList: makeItemList(length), itemCount }])[0].count;
  assert.equal(countOf(3, 9), 3);
  assert.equal(countOf(0, 5), 0);
  assert.equal(countOf(15, 20), 20);
  assert.equal(countOf(12, 12), 12);
  assert.equal(countOf(15, 7), null);
  assert.equal(countOf(15, undefined), null);
  assert.equal(countOf(15, '20'), null);
});

test('요청: 그림 한 장 + 카드 프롬프트, temperature 0·출력 900토큰, 프롬프트 JSON 모드라 response_format 을 넣지 않는다', async () => {
  const bodyList = installFetch();
  const result = await createFactCardAgent({ config }).build({ jpegBuffer: Buffer.from('jpeg') });
  assert.equal(bodyList.length, 1);
  const [body] = bodyList;
  assert.equal(FACT_CARD_MAX_TOKENS, 900);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 900);
  assert.equal(body.response_format, undefined);
  assert.equal(body.messages[0].content.filter((block) => block.type === 'image_url').length, 1);
  assert.equal(body.messages[0].content.at(-1).text, buildFactCardPrompt());
  assert.equal(result.screenTitle, '국내 판매 현황');
  assert.deepEqual(result.cardList[0], expectedChart);
  assert.equal(result.isTruncated, false);
  assert.equal(result.jsonMode, 'prompt');
  assert.equal(result.rawLength, JSON.stringify(response).length);
});

test('설정에 다른 JSON 모드가 와도 response_format 을 넣지 않는다', async () => {
  const bodyList = installFetch();
  await createFactCardAgent({ config: { ...config, factCardJsonMode: 'schema' } }).build({ jpegBuffer: Buffer.from('jpeg') });
  assert.equal(bodyList[0].response_format, undefined);
});

test('HTTP 오류·해석 실패는 던진다(카드 저장소가 failed 로 둔다)', async () => {
  installFetch({ status: 500 });
  await assert.rejects(createFactCardAgent({ config }).build({ jpegBuffer: Buffer.from('jpeg') }), /HTTP 500/);
  installFetch({ content: '화면에 글자가 없습니다' });
  await assert.rejects(createFactCardAgent({ config }).build({ jpegBuffer: Buffer.from('jpeg') }), /해석/);
});

test('카드 프롬프트: 적힌 그대로 옮기고, 그래프 높이로 값을 어림하지 않으며, JSON 하나만 내게 한다', () => {
  const prompt = buildFactCardPrompt();
  assert.match(prompt, /패널별 사실 카드/);
  assert.match(prompt, /적힌 그대로/);
  assert.match(prompt, /어림하지 않는다/);
  assert.match(prompt, /JSON 하나만 출력한다/);
  assert.match(prompt, /"screenTitle":"","cardList":\[\]/);
});
