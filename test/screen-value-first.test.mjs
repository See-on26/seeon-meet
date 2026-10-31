import { test, afterEach } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readContentSwitch, CONTENT_SWITCH_ENV_NAME_MAP } = require('../src/main/caption-pipeline/agents/shared/content-switch.js');
const {
  extractApproximateValueList, isNearApproximateValue, checkSpokenValueMatch, SPOKEN_VALUE_VERDICT_MAP,
} = require('../src/main/caption-pipeline/prompts/approximate-value.js');
const { getSlotList } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const {
  buildInterpretationPrompt, buildInterpretationScreenTextBlock,
} = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');
const { buildVisualDescriptionPrompt } = require('../src/main/caption-pipeline/prompts/visual-description.js');
const { createInterpretiveBridgeAgent } = require('../src/main/caption-pipeline/agents/interpretive-bridge-agent.js');

// 발화 어림 되풀이 막기: 발표자가 "약 3천 명"처럼 어림해 말해도, 화면에 그 값이 글자로 적혀 있으면(2,870명) 화면 값을 말하게 한다.
// 범위는 화면에 글자로 적힌 값뿐이다. 라벨 없는 막대·선 높이를 눈금으로 읽는 일은 하지 않고, 값 검사(value-presence)는 그대로다.
// 다른 스위치는 셸 환경변수에 기대지 않게 모두 켠 값으로 고정한다.
const ALL_ON = { isFactCompleteEnabled: true, isTimeMarkEnabled: true, isScreenValueFirstEnabled: true, isScaleValueFirstEnabled: true };
const ON = ALL_ON;
const OFF = { ...ALL_ON, isScreenValueFirstEnabled: false };
const APPROXIMATE_LINE_PATTERN = /발표자는 수치를 어림해 말했다/;

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('스위치: SEEON_SCREEN_VALUE_FIRST_ENABLED 는 기본 켜짐이고 "false" 일 때만 끈다', () => {
  assert.equal(CONTENT_SWITCH_ENV_NAME_MAP.isScreenValueFirstEnabled, 'SEEON_SCREEN_VALUE_FIRST_ENABLED');
  assert.equal(readContentSwitch({}).isScreenValueFirstEnabled, true);
  assert.equal(readContentSwitch({ SEEON_SCREEN_VALUE_FIRST_ENABLED: 'false' }).isScreenValueFirstEnabled, false);
});

test('어림 값 찾기: 약·대략·거의·한 앞말과 정도·쯤·가량·여·남짓·넘게 뒷말이 붙은 수만 고른다', () => {
  const read = (text) => extractApproximateValueList(text).map(({ phrase, value }) => [phrase, value]);
  assert.deepEqual(read('매출이 약 600억 정도입니다'), [['약 600억 정도', 6e10]]);
  assert.deepEqual(read('한 3천 명쯤 왔어요'), [['한 3천 명쯤', 3000]]);
  assert.deepEqual(read('40여 명이 참석했고'), [['40여 명', 40]]);
  assert.deepEqual(read('거의 20%까지 갔습니다'), [['거의 20%', 20]]);
  assert.deepEqual(read('1,200명 넘게 신청했습니다'), [['1,200명 넘게', 1200]]);
  assert.deepEqual(read('about 600 people joined'), [['about 600', 600]]);
  assert.deepEqual(read('73%입니다'), []);
  assert.deepEqual(read('이에 대한 600건의 의견'), [], '"대한"의 "한"은 어림 앞말이 아니다');
  assert.deepEqual(read('세 번째 안건'), []);
});

test('가까운 값: 화면 글자의 수가 어림 값의 ±15% 안이면 가깝다고 본다(천·만·억 단위와 쉼표를 읽는다)', () => {
  const approximateValueList = extractApproximateValueList('한 3천 명쯤 왔어요');
  assert.equal(isNearApproximateValue({ text: '서울 지점 방문자 2,870명', approximateValueList }), true);
  assert.equal(isNearApproximateValue({ text: '누적 0.29만 명', approximateValueList }), true);
  assert.equal(isNearApproximateValue({ text: '처리 건수 120건', approximateValueList }), false);
  assert.equal(isNearApproximateValue({ text: '방문자 4,100명', approximateValueList }), false);
  assert.equal(isNearApproximateValue({ text: '방문자 2,870명', approximateValueList: [] }), false);
});

test('수치 프롬프트: 켜면 발화의 어림 값을 짚어 화면에 글자로 적힌 값을 쓰게 하고, 눈금으로 새 값을 만들지 않게 한다', () => {
  for (const subKind of ['claim_to_value', 'value_to_meaning']) {
    const on = buildInterpretationPrompt({ utterance: '방문자가 한 3천 명쯤으로 늘었습니다', subKind, contentSwitch: ON });
    assert.match(on, APPROXIMATE_LINE_PATTERN, subKind);
    assert.match(on, /"한 3천 명쯤"/, subKind);
    assert.match(on, /화면에 글자로 적힌 값이 없을 때만/, subKind);
    assert.match(on, /눈금으로 어림해 새 값을 만들지 않는다/, subKind);
    const off = buildInterpretationPrompt({ utterance: '방문자가 한 3천 명쯤으로 늘었습니다', subKind, contentSwitch: OFF });
    assert.doesNotMatch(off, APPROXIMATE_LINE_PATTERN, subKind);
    // 어림이 없는 발화에는 짚는 줄 없이 일반 규칙만 둔다.
    const exact = buildInterpretationPrompt({ utterance: '방문자가 크게 늘었습니다', subKind, contentSwitch: ON });
    assert.doesNotMatch(exact, APPROXIMATE_LINE_PATTERN, subKind);
    assert.match(exact, /잘못 들린 것으로 보일 만큼 가까우면/, subKind);
    assert.match(exact, /다른 대상\(옆 막대·다른 항목\)의 값으로 바꾸지 않는다/, subKind);
    assert.doesNotMatch(exact, /화면에 글자로 적힌 값과 다르면 화면에 적힌 값을 쓴다/, subKind);
    assert.doesNotMatch(off, /잘못 들린 것으로 보일 만큼/, subKind);
    // 어림 값을 짚는 줄도 어림 값과 크게 다른 수(다른 대상의 값)로 바꾸지 않게 한다.
    assert.match(on, /어림 값과 크게 다른 수는 다른 대상의 값이니 쓰지 않는다/, subKind);
  }
  // 둘째 변화 표현의 어림 값도 짚는다.
  const merged = buildInterpretationPrompt({
    utterance: '매출이 늘었습니다', subKind: 'claim_to_value', mergedClaimList: ['방문자도 약 500명 늘었고'], contentSwitch: ON,
  });
  assert.match(merged, /"약 500명"/);
});

test('값→의미 값 칸: 켜면 발화의 수치를 화면에 적힌 꼴로 쓰게 한다(발화가 어림했으면 화면의 정확한 값)', () => {
  const on = getSlotList({ narrationType: 'interpretation', subKind: 'value_to_meaning', contentSwitch: ON }).find((slot) => slot.key === 'value');
  assert.match(on.label, /화면에 적힌/);
  assert.match(on.label, /어림/);
  assert.equal(on.mustContainValue, true);
  const off = getSlotList({ narrationType: 'interpretation', subKind: 'value_to_meaning', contentSwitch: OFF }).find((slot) => slot.key === 'value');
  assert.equal(off.label, '발화에 나온 단순 수치 (예: 73%)');
  const english = getSlotList({ narrationType: 'interpretation', subKind: 'value_to_meaning', contentSwitch: ON, language: 'en' })
    .find((slot) => slot.key === 'value');
  assert.ok(!/[가-힣]/.test(english.label));
  assert.match(english.label, /approximat/);
});

// 글자 많은 화면에서 어림 값에 가까운 값이 아래쪽에 있으면 600자 상한에 잘려 모델이 그 값을 확인할 수 없었다.
const fillerLineList = Array.from({ length: 24 }, (_, index) => ({
  text: `${String(index + 1).padStart(2, '0')}. 운영 지표 항목의 이번 달 처리 건수는 ${index + 100}건이다.`, score: 0.95,
}));
// 발화 낱말(방문자)이 든 줄은 이미 먼저 들어가므로, 가까운 값만으로 고르는지 보려고 다른 낱말(입장객)로 적는다.
const visitorLine = { text: '25. 서울 지점 입장객 2,870명', score: 0.95 };

test('OCR 덩어리: 켜면 어림 값에 가까운 수가 든 줄을 상한 안에 먼저 넣는다', () => {
  const screenLineList = [...fillerLineList, visitorLine];
  const option = { screenLineList, utterance: '방문자가 한 3천 명쯤 왔습니다', subKind: 'value_to_meaning' };
  assert.ok(buildInterpretationScreenTextBlock({ ...option, contentSwitch: ON }).text.includes(visitorLine.text));
  assert.ok(!buildInterpretationScreenTextBlock({ ...option, contentSwitch: OFF }).text.includes(visitorLine.text));
  assert.ok(buildInterpretationPrompt({ ...option, contentSwitch: ON }).includes(visitorLine.text));
});

test('척도 프롬프트도 켜면 어림 값을 짚는다', () => {
  const option = { subKind: 'scale', utterance: '거의 600명이나 모였어요, 정말 많죠' };
  assert.match(buildVisualDescriptionPrompt({ ...option, contentSwitch: ON }), /"거의 600명"/);
  assert.doesNotMatch(buildVisualDescriptionPrompt({ ...option, contentSwitch: OFF }), APPROXIMATE_LINE_PATTERN);
});

test('에이전트: config 스위치를 프롬프트에 넘기고, 넣은 OCR 줄 수도 같은 스위치로 센다', async () => {
  const promptList = [];
  globalThis.fetch = async (_url, option) => {
    promptList.push(JSON.parse(option.body).messages[0].content.find((item) => item.type === 'text').text);
    const content = JSON.stringify({ value: '2,870명', frame: '서울 지점 입장객 수' });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const config = { vlmUrl: 'http://x', vlmModel: 'm' };
  const generateArgs = {
    jpegBuffer: Buffer.from('x'), utterance: '방문자가 한 3천 명쯤 왔습니다', subKind: 'value_to_meaning',
    screenLineList: [...fillerLineList, visitorLine],
  };
  const on = await createInterpretiveBridgeAgent({ config: { ...config, contentSwitch: ON } }).generate(generateArgs);
  assert.match(promptList[0], APPROXIMATE_LINE_PATTERN);
  const off = await createInterpretiveBridgeAgent({ config: { ...config, contentSwitch: OFF } }).generate(generateArgs);
  assert.doesNotMatch(promptList[1], APPROXIMATE_LINE_PATTERN);
  assert.equal(on.text, '2,870명은 서울 지점 입장객 수를 의미');
  assert.ok(on.screenTextBlock.charCount !== off.screenTextBlock.charCount || on.screenTextBlock.lineCount !== off.screenTextBlock.lineCount);
});

test('어림 값 찾기: 연도·낱말 첫머리·영어 단위를 어림 값으로 잘못 읽지 않고, 영어 배수와 범위를 읽는다', () => {
  const read = (text) => extractApproximateValueList(text).map(({ phrase, value }) => [phrase, value]);
  assert.deepEqual(read('nearly 1.2 million users'), [['nearly 1.2 million', 1.2e6]]);
  assert.deepEqual(read('about 2.5k downloads'), [['about 2.5k', 2500]]);
  assert.deepEqual(read('거의 2020년부터 써 왔어요'), [], '연도는 어림 값이 아니다');
  assert.deepEqual(read('around 2019 we started'), [], '연도는 어림 값이 아니다');
  assert.deepEqual(read('슬라이드 3 여기 보시면'), [], '"여기"의 "여"는 어림 꼬리가 아니다');
  assert.deepEqual(read('40여명이 왔어요'), [['40여명', 40]]);
  assert.deepEqual(read('약 3~4배 늘었어요'), [['약 3~4배', 3.5]]);
  assert.deepEqual(read('약 3년 걸렸어요'), [['약 3년', 3]], '기간(3년)은 어림 값이다');
});

// 값→의미는 발표자가 말한 그 수를 읽는다. 화면에 있는 수라고 해서 옆 막대의 값으로 바꿔 쓰면 값 검사(화면에 있나)를 통과해 버린다.
test('발화 값 대조: 값→의미 값이 발화의 수와 같거나 어림 값의 ±15% 안이면 받고, 멀면(옆 대상의 값) 거른다', () => {
  const verdict = (value, utterance) => checkSpokenValueMatch({ value, utterance }).verdict;
  assert.equal(verdict('1,240명', '약 800명이 참여했어요'), SPOKEN_VALUE_VERDICT_MAP.far);
  assert.equal(verdict('770명', '약 800명이 참여했어요'), SPOKEN_VALUE_VERDICT_MAP.near);
  assert.equal(verdict('2,870명', '한 3천 명쯤 왔어요'), SPOKEN_VALUE_VERDICT_MAP.near);
  assert.equal(verdict('73%', '약 800명 중에 73%가 응답했어요'), SPOKEN_VALUE_VERDICT_MAP.near, '발화에 그대로 나온 수');
  assert.equal(verdict('73%', '칠십삼 퍼센트가 응답했어요'), SPOKEN_VALUE_VERDICT_MAP.unchecked, '발화에 아라비아 숫자가 없으면 견줄 수 없다');
  assert.equal(verdict('높은 편', '약 800명이 참여했어요'), SPOKEN_VALUE_VERDICT_MAP.unchecked);
});

test('파이프라인: 화면 값 먼저가 켜져 있으면 값→의미 값을 발화의 수와 대조해, 먼 값은 읽지 않고 기록에 남긴다', () => {
  const source = fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');
  assert.match(source, /checkSpokenValueMatch\(\{/);
  assert.match(source, /config\.contentSwitch\?\.isScreenValueFirstEnabled/);
  assert.match(source, /skipReason: 'value-far-from-spoken'/);
});
