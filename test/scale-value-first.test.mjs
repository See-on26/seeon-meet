import { test, afterEach } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readContentSwitch, CONTENT_SWITCH_ENV_NAME_MAP } = require('../src/main/caption-pipeline/agents/shared/content-switch.js');
const { assembleNarration, getSlotList } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { buildSlotOutputInstruction } = require('../src/main/caption-pipeline/agents/shared/caption-parser.js');
const {
  buildVisualDescriptionPrompt, buildScaleScreenTextBlock,
} = require('../src/main/caption-pipeline/prompts/visual-description.js');
const { createVisualDescriptionAgent } = require('../src/main/caption-pipeline/agents/visual-description-agent.js');
const { isStatLine } = require('../src/main/caption-pipeline/prompts/screen-text-block.js');
const { readValueCheckTarget, isValuePresent } = require('../src/main/caption-pipeline/orchestrator/value-presence.js');

// 척도 에이전트 다시 만들기: 회의 화면의 척도 대상은 대개 그래프·지도·표라 견줄 사물이 없어 "비교 대상 없음"으로 NONE 이 많았다.
// 대상 둘레에 글자로 적힌 값(통계 패널·툴팁·범례·라벨·눈금)을 먼저 읽고, 대상이 보이면 NONE 을 내지 않게 한다.
// 화면에 없는 값은 지어내지 않는다(막대·선 높이를 눈금으로 어림하지 않는다).
// 다른 스위치는 셸 환경변수에 기대지 않게 모두 켠 값으로 고정한다.
const ALL_ON = { isFactCompleteEnabled: true, isTimeMarkEnabled: true, isScreenValueFirstEnabled: true, isScaleValueFirstEnabled: true };
const ON = ALL_ON;
const OFF = { ...ALL_ON, isScaleValueFirstEnabled: false };
const LISTENER_LINE_PREFIX = '청자는 화면을 볼 수 없다. 발표자는';

const scale = (rawSlotMap, option = {}) => assembleNarration({
  narrationType: 'visual_description', subKind: 'scale', rawSlotMap, ...option,
})?.text ?? null;

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('스위치: SEEON_SCALE_VALUE_FIRST_ENABLED 는 기본 켜짐이고 "false" 일 때만 끈다', () => {
  assert.equal(CONTENT_SWITCH_ENV_NAME_MAP.isScaleValueFirstEnabled, 'SEEON_SCALE_VALUE_FIRST_ENABLED');
  assert.equal(readContentSwitch({}).isScaleValueFirstEnabled, true);
  assert.equal(readContentSwitch({ SEEON_SCALE_VALUE_FIRST_ENABLED: 'false' }).isScaleValueFirstEnabled, false);
});

test('척도 칸: 켜면 적힌 값을 먼저 옮기는 reading(읽지 않음) + caption(3~8어절), 끄면 예전 caption 하나', () => {
  const slotList = getSlotList({ narrationType: 'visual_description', subKind: 'scale', contentSwitch: ON });
  assert.deepEqual(slotList.map((slot) => slot.key), ['reading', 'caption']);
  assert.equal(slotList[0].isDiagnostic, true);
  assert.match(slotList[0].label, /통계 패널·툴팁·범례/);
  assert.deepEqual([slotList[1].minWordCount, slotList[1].maxWordCount], [3, 8]);
  assert.match(slotList[1].label, /적힌 그 값/);
  assert.deepEqual(getSlotList({ narrationType: 'visual_description', subKind: 'scale', contentSwitch: OFF }).map((slot) => slot.key), ['caption']);
  const english = buildSlotOutputInstruction({ narrationType: 'visual_description', subKind: 'scale', language: 'en', contentSwitch: ON });
  assert.match(english, /"reading": /);
  assert.ok(!/[가-힣]/.test(english));
});

test('척도 조립: reading 은 읽지 않고 caption 만 읽으며, 끝 목적격 조사는 뗀다', () => {
  assert.equal(scale({ reading: '둘레 12.4km', caption: '둘레 12.4km인 호수를' }, { contentSwitch: ON }), '둘레 12.4km인 호수');
  assert.equal(scale({ caption: '소나무보다 4배 정도 큰 불상' }, { contentSwitch: ON }), '소나무보다 4배 정도 큰 불상');
  assert.equal(scale({ reading: '1,240건', caption: '' }, { contentSwitch: ON }), null);
});

test('척도 프롬프트: 켜면 적힌 값 → 화면 속 다른 대상 → 일반 사물 순으로 근거를 찾고, 대상이 보이면 NONE 을 내지 않는다', () => {
  const prompt = buildVisualDescriptionPrompt({ subKind: 'scale', utterance: '이 막대 정말 길죠', contentSwitch: ON });
  const valueIndex = prompt.indexOf('통계 패널');
  const otherIndex = prompt.indexOf('같은 화면의 다른 대상');
  const commonIndex = prompt.indexOf('누구나 크기를 아는 일반 사물');
  assert.ok(valueIndex > 0 && valueIndex < otherIndex && otherIndex < commonIndex, '근거 순서');
  assert.match(prompt, /툴팁/);
  assert.match(prompt, /범례/);
  assert.match(prompt, /대상이 화면에 보이면 "NONE"을 내지 않는다/);
  assert.match(prompt, /대상을 화면에서 찾을 수 없을 때, 또는 대상은 보이지만 적힌 값도 견줄 다른 대상도 전혀 없을 때/);
  assert.match(prompt, /눈금으로 어림해 새 수치를 만들지 않는다/);
  assert.doesNotMatch(prompt, /비교 대상을 찾을 수 없으면/);
  // 예전 꼴(만 한·배수)과 청자 줄은 그대로 둔다.
  assert.match(prompt, /만 한/);
  assert.match(prompt, /소나무보다 4배 정도 큰 불상/);
  assert.match(prompt, /"reading":/);
  assert.ok(prompt.includes(LISTENER_LINE_PREFIX));
  const legacy = buildVisualDescriptionPrompt({ subKind: 'scale', utterance: '이 막대 정말 길죠', contentSwitch: OFF });
  assert.match(legacy, /비교 대상을 찾을 수 없으면 "NONE"만 출력한다/);
  assert.doesNotMatch(legacy, /통계 패널|"reading":/);
});

test('척도 프롬프트: 켜면 이름·자료 종류만 안내된 대상은 거절하지 않고 그 정도를 말하게 한다', () => {
  const option = { subKind: 'scale', utterance: '이 막대 정말 길죠', describedElementList: ['슬라이드 3: 지점별 매출 막대그래프'] };
  const on = buildVisualDescriptionPrompt({ ...option, contentSwitch: ON });
  assert.match(on, /이름·자료 종류만 안내됐다면 반복하지 말고 그 정도/);
  assert.match(on, /지점별 매출 막대그래프/);
  assert.doesNotMatch(on, /이미 안내된 요소\(.*\)면 반복하지 말고/);
  const off = buildVisualDescriptionPrompt({ ...option, contentSwitch: OFF });
  assert.match(off, /이미 안내된 요소\(.*\)면 반복하지 말고 "NONE"만 출력한다/);
});

// 글자 많은 화면 아래쪽의 통계 패널이 600자 상한에 잘리면 척도 에이전트가 적힌 값을 볼 수 없었다.
const fillerLineList = Array.from({ length: 24 }, (_, index) => ({
  text: `${String(index + 1).padStart(2, '0')}. 운영 지표 항목의 이번 달 처리 건수는 ${index + 100}건이다.`, score: 0.95,
}));
const statLine = { text: '합계 4,820건 · 최대 1,240건', score: 0.95 };

test('척도 OCR 덩어리: 켜면 통계 낱말(합계·평균·최대 등)이 든 줄을 먼저 넣고, 안내 줄에 통계 패널·툴팁·범례를 적는다', () => {
  const option = { screenLineList: [...fillerLineList, statLine], utterance: '이 막대 정말 길죠' };
  const on = buildScaleScreenTextBlock({ ...option, contentSwitch: ON });
  assert.ok(on.text.includes(statLine.text));
  const usageLine = on.text.split('\n')[1];
  assert.match(usageLine, /통계 패널·툴팁·범례/);
  assert.match(usageLine, /비교 대상/);
  assert.match(usageLine, /반드시 이미지에서 확인한다/);
  const off = buildScaleScreenTextBlock({ ...option, contentSwitch: OFF });
  assert.ok(!off.text.includes(statLine.text));
  assert.doesNotMatch(off.text.split('\n')[1], /통계 패널/);
});

test('척도 에이전트: config 스위치를 프롬프트·조립·OCR 양 세기에 넘긴다', async () => {
  const promptList = [];
  globalThis.fetch = async (_url, option) => {
    promptList.push(JSON.parse(option.body).messages[0].content.find((item) => item.type === 'text').text);
    const content = '{"reading":"최대 1,240건","caption":"최대 1,240건으로 가장 긴 막대"}';
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const config = { vlmUrl: 'http://x', vlmModel: 'm' };
  const generateArgs = {
    jpegBuffer: Buffer.from('x'), subKind: 'scale', utterance: '이 막대 정말 길죠', screenLineList: [...fillerLineList, statLine],
  };
  const on = await createVisualDescriptionAgent({ config: { ...config, contentSwitch: ON } }).generate(generateArgs);
  assert.equal(on.text, '최대 1,240건으로 가장 긴 막대');
  assert.match(promptList[0], /"reading":/);
  assert.ok(promptList[0].includes(statLine.text));
  const off = await createVisualDescriptionAgent({ config: { ...config, contentSwitch: OFF } }).generate(generateArgs);
  assert.doesNotMatch(promptList[1], /"reading":/);
  assert.notDeepEqual(on.screenTextBlock, off.screenTextBlock);
});

// 척도는 NONE 을 덜 내게 바꿔 화면에 없는 값을 지어낼 위험이 커졌다. 수치 해설처럼 해설의 수가 화면 글자에 있는지 본다.
test('척도 값 검사: 켜면 caption 의 수(배수 제외)를 화면 글자와 대조할 값으로 넘기고, 화면에 없으면 absent 다', () => {
  const target = (caption, contentSwitch = ON) => readValueCheckTarget({
    narrationType: 'visual_description', subKind: 'scale', slotMap: { reading: '', caption }, contentSwitch,
  });
  const invented = target('약 5,000건 정도로 가장 긴 막대');
  assert.equal(invented.checkSubKind, 'claim_to_value', '화면 글자에만 대조한다(발화 제외)');
  assert.match(invented.value, /5,000/);
  assert.equal(isValuePresent({ ...invented, subKind: invented.checkSubKind, slideText: '분기별 처리 건수 1,240 310', slideTextStatus: 'ready' }).verdict,
    'absent');
  const written = target('옆 막대 310건보다 긴 1,240건 막대');
  assert.equal(isValuePresent({ value: written.value, subKind: written.checkSubKind, slideText: '분기별 처리 건수 1,240건 310건', slideTextStatus: 'ready' }).verdict,
    'present');
  // 견준 배수·분수는 화면에 적힌 값이 아니라 대조하지 않는다.
  assert.equal(target('소나무보다 4배 정도 큰 불상'), null);
  assert.equal(target('옆 건물의 3분의 1 크기인 창고'), null);
  assert.equal(target('옆 건물보다 높은 전망대'), null);
  assert.equal(target('약 5,000건 정도로 가장 긴 막대', OFF), null, '끄면 예전처럼 척도는 대조하지 않는다');
  // 칸 JSON 이 아닌 답(slotMap 없음)도 읽을 해설로 대조한다.
  assert.match(readValueCheckTarget({ narrationType: 'visual_description', subKind: null, slotMap: null, text: '약 5,000건 정도로 가장 긴 막대',
    contentSwitch: ON }).value, /5,000/);
});

test('값 검사 대상: 수치 해설은 예전과 같이 값 칸을, 그 세부 종류(없으면 값→의미)로 대조한다', () => {
  assert.deepEqual(readValueCheckTarget({ narrationType: 'interpretation', subKind: 'claim_to_value', slotMap: { value: '9.2시간에서 3.1시간' }, contentSwitch: OFF }),
    { value: '9.2시간에서 3.1시간', checkSubKind: 'claim_to_value' });
  assert.deepEqual(readValueCheckTarget({ narrationType: 'interpretation', subKind: null, slotMap: { value: '73%' }, contentSwitch: OFF }),
    { value: '73%', checkSubKind: 'value_to_meaning' });
  assert.equal(readValueCheckTarget({ narrationType: 'interpretation', subKind: 'claim_to_value', slotMap: { value: '' }, contentSwitch: ON }), null);
  assert.equal(readValueCheckTarget({ narrationType: 'deixis', subKind: 'simple', slotMap: { caption: '2024년 매출 표' }, contentSwitch: ON }), null);
});

test('파이프라인: 값 검사 대상을 readValueCheckTarget 으로 고르고 그 세부 종류로 대조한다', () => {
  const source = fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');
  assert.match(source, /readValueCheckTarget\(\{/);
  assert.match(source, /subKind: valueCheckTarget\.checkSubKind/);
});

test('통계 줄: "최고경영자"·"5 min" 같은 낱말은 통계 줄로 보지 않는다', () => {
  for (const text of ['최고 1,240건', '최대값 98', '합계 4,820건', 'max: 12', 'Min 3.2', '평균 3.2', 'total 4,820']) assert.equal(isStatLine(text), true, text);
  for (const text of ['최고경영자 인사말', '5 min read', '최대한 빨리 처리', '최소화 방안']) assert.equal(isStatLine(text), false, text);
});
