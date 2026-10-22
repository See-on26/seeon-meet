import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  readContentSwitch, resolveContentSwitch, CONTENT_SWITCH_ENV_NAME_MAP,
} = require('../src/main/caption-pipeline/agents/shared/content-switch.js');
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');
const { assembleNarration, getSlotList, normalizeSlotMap } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { buildSlotOutputInstruction, parseSlotCaption } = require('../src/main/caption-pipeline/agents/shared/caption-parser.js');
const { buildGroundingPrompt, DEIXIS_FORM_RULE_MAP } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');
const { createDeixisResolutionAgent } = require('../src/main/caption-pipeline/agents/deixis-resolution-agent.js');
const { createInterpretiveBridgeAgent } = require('../src/main/caption-pipeline/agents/interpretive-bridge-agent.js');

// 식별 사실 완결: 해설이 고른 대상의 개수·범위(처음과 끝)·조건·지명·비교 상대·시점을 빠뜨리지 않게 한다.
// 지시 단순형은 읽히는 칸이 caption 하나라 세부가 seen(읽지 않는 근거 칸)에만 남고 빠졌다. 식별 사실 칸(fact)을 따로 받는다.
const ON = { isFactCompleteEnabled: true };
const OFF = { isFactCompleteEnabled: false };
const HANGUL_PATTERN = /[가-힣]/;

const deixis = (rawSlotMap, option = {}) => assembleNarration({
  narrationType: 'deixis', subKind: 'simple', rawSlotMap, ...option,
})?.text ?? null;

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockVlm(content) {
  const promptList = [];
  globalThis.fetch = async (_url, option) => {
    promptList.push(JSON.parse(option.body).messages[0].content.find((item) => item.type === 'text').text);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return promptList;
}

test('스위치: SEEON_FACT_COMPLETE_ENABLED 는 기본 켜짐이고 "false" 일 때만 끈다', () => {
  assert.equal(CONTENT_SWITCH_ENV_NAME_MAP.isFactCompleteEnabled, 'SEEON_FACT_COMPLETE_ENABLED');
  assert.equal(readContentSwitch({}).isFactCompleteEnabled, true);
  assert.equal(readContentSwitch({ SEEON_FACT_COMPLETE_ENABLED: 'true' }).isFactCompleteEnabled, true);
  assert.equal(readContentSwitch({ SEEON_FACT_COMPLETE_ENABLED: 'false' }).isFactCompleteEnabled, false);
  assert.equal(readPipelineConfig({}).contentSwitch.isFactCompleteEnabled, true);
  assert.equal(readPipelineConfig({ SEEON_FACT_COMPLETE_ENABLED: 'false' }).contentSwitch.isFactCompleteEnabled, false);
  // 일부만 준 스위치는 나머지를 환경변수(기본 켜짐)로 채운다.
  assert.equal(resolveContentSwitch({}).isFactCompleteEnabled, true);
  assert.equal(resolveContentSwitch(OFF).isFactCompleteEnabled, false);
});

test('지시 단순형 칸: 켜면 seen + caption(2~5어절, 7어절까지 받음) + fact(0~3어절), 끄면 예전 seen + caption', () => {
  const slotList = getSlotList({ narrationType: 'deixis', subKind: 'simple', contentSwitch: ON });
  assert.deepEqual(slotList.map((slot) => slot.key), ['seen', 'caption', 'fact']);
  const [, caption, fact] = slotList;
  assert.deepEqual([caption.minWordCount, caption.maxWordCount, caption.overageWordCount], [2, 5, 2]);
  assert.deepEqual([fact.minWordCount, fact.maxWordCount], [0, 3]);
  assert.match(fact.label, /개수/);
  assert.match(fact.label, /범위/);
  assert.match(fact.label, /시점/);
  assert.match(fact.label, /지명/);
  assert.match(fact.label, /비교 상대/);
  assert.deepEqual(getSlotList({ narrationType: 'deixis', subKind: 'simple', contentSwitch: OFF }).map((slot) => slot.key), ['seen', 'caption']);
  // 완전형은 대상이 여럿이라 칸을 나누지 않고 caption 설명에 가르는 사실을 담게 한다.
  const complete = getSlotList({ narrationType: 'deixis', subKind: 'complete', contentSwitch: ON });
  assert.deepEqual(complete.map((slot) => slot.key), ['seen', 'caption']);
  assert.match(complete[1].label, /개수·시점·지명/);
});

test('지시 단순형 조립: caption 뒤에 fact 를 쉼표로 잇고, 비었거나 caption 에 이미 있으면 붙이지 않는다', () => {
  assert.equal(deixis({ seen: '월별 매출 추이 그래프, 세로축 0~800', caption: '월별 매출 추이 그래프', fact: '세로축 0~800' }),
    '월별 매출 추이 그래프, 세로축 0~800');
  assert.equal(deixis({ seen: '강가의 돌다리 사진', caption: '강가의 돌다리 사진', fact: '' }), '강가의 돌다리 사진');
  assert.equal(deixis({ seen: '강가의 돌다리 사진', caption: '강가의 돌다리 사진' }), '강가의 돌다리 사진');
  assert.equal(deixis({ seen: '관리 항목 11개', caption: '11개 관리 항목 표', fact: '11개 항목' }), '11개 관리 항목 표');
  // fact 끝 목적격 조사도 caption 처럼 뗀다.
  assert.equal(deixis({ seen: '서울·부산 두 도시', caption: '도시별 강수량 지도', fact: '서울·부산 두 도시를' }), '도시별 강수량 지도, 서울·부산 두 도시');
  // 끄면 fact 는 읽지 않는다.
  assert.equal(deixis({ seen: '월별 매출 추이 그래프', caption: '월별 매출 추이 그래프', fact: '세로축 0~800' }, { contentSwitch: OFF }),
    '월별 매출 추이 그래프');
});

test('지시 단순형 조립: caption 은 예전 상한(7어절)까지 받고, 이은 해설은 8어절 안으로 caption 끝부터 줄인다', () => {
  assert.equal(deixis({ seen: 's', caption: '서울 부산 대구 세 도시 월별 강수량', fact: '' }), '서울 부산 대구 세 도시 월별 강수량');
  const text = deixis({ seen: 's', caption: '서울 부산 대구 세 도시 월별 강수량', fact: '2019~2023년 5년' });
  assert.ok(text.split(' ').length <= 8, text);
  assert.ok(text.endsWith(', 2019~2023년 5년'), text);
  assert.ok(text.startsWith('서울 부산 대구'), text);
});

test('범위 끝: 상한에서 잘린 칸도 숫자에 붙은 "…까지·부터"는 떼지 않는다(끄면 예전처럼 뗀다)', () => {
  const slotList = [{ key: 'frame', minWordCount: 3, maxWordCount: 4, isPhrase: true }];
  const rawSlotMap = { frame: '접수 기간 3월 2일부터 4월 30일까지 운영' };
  assert.equal(normalizeSlotMap({ slotList, rawSlotMap: { frame: '접수 기간 3월 2일부터 끝' }, contentSwitch: ON }).frame, '접수 기간 3월 2일부터');
  assert.equal(normalizeSlotMap({ slotList, rawSlotMap: { frame: '판매 목표 1월부터 12월까지 매월' }, contentSwitch: ON }).frame,
    '판매 목표 1월부터 12월까지');
  assert.equal(normalizeSlotMap({ slotList, rawSlotMap: { frame: '판매 목표 1월부터 12월까지 매월' }, contentSwitch: OFF }).frame, '판매 목표');
  assert.equal(normalizeSlotMap({ slotList, rawSlotMap, contentSwitch: ON }).frame, '접수 기간 3월 2일부터');
});

test('지시 프롬프트: 켜면 fact 칸과 가르는 사실 규칙을 안내하고, 형식 예시의 caption·fact 는 seen 낱말로만 쓴다', () => {
  const simple = buildGroundingPrompt({ utterance: '여기 보시면', maxChars: 60, subKind: 'simple', contentSwitch: ON });
  assert.match(simple, /"fact":/);
  assert.match(simple, /fact="/);
  assert.match(simple, /몇 개인가/);
  assert.match(simple, /언제부터 언제까지/);
  const complete = buildGroundingPrompt({ utterance: '이거랑 이거', maxChars: 60, subKind: 'complete', contentSwitch: ON });
  assert.doesNotMatch(complete, /"fact":|fact="/);
  assert.match(complete, /몇 개인가/);
  const legacy = buildGroundingPrompt({ utterance: '여기 보시면', maxChars: 60, subKind: 'simple', contentSwitch: OFF });
  assert.doesNotMatch(legacy, /"fact":|fact="|몇 개인가/);

  const exampleLineList = buildGroundingPrompt({ utterance: '여기', maxChars: 60, subKind: 'simple', contentSwitch: ON })
    .split('\n').filter((line) => line.includes('fact="'));
  assert.ok(exampleLineList.length >= 2);
  const toWordList = (text) => text.split(/[\s,·]+/).filter(Boolean);
  for (const line of exampleLineList) {
    const [, seen, caption, fact] = line.match(/seen="([^"]*)", caption="([^"]*)", fact="([^"]*)"/);
    const seenWordSet = new Set(toWordList(seen));
    for (const word of [...toWordList(caption), ...toWordList(fact)]) assert.ok(seenWordSet.has(word), `"${word}" 이 seen("${seen}")에 없다`);
  }
  assert.ok(Object.values(DEIXIS_FORM_RULE_MAP).flat().every((line) => !line.includes('fact=')), '끈 판의 예시는 그대로다');
});

test('수치 칸: 켜면 근거 줄 칸(source, 읽지 않음)을 앞에 두고, 해석틀은 6어절까지, 대상 칸은 시점·조건을 함께 쓰게 한다', () => {
  const meaning = getSlotList({ narrationType: 'interpretation', subKind: 'value_to_meaning', contentSwitch: ON });
  assert.deepEqual(meaning.map((slot) => slot.key), ['source', 'value', 'frame']);
  assert.equal(meaning[0].isDiagnostic, true);
  assert.equal(meaning[2].maxWordCount, 6);
  assert.match(meaning[2].label, /비교 상대·시점·조건/);
  const claim = getSlotList({ narrationType: 'interpretation', subKind: 'claim_to_value', contentSwitch: ON });
  assert.deepEqual(claim.map((slot) => slot.key), ['source', 'target', 'value']);
  assert.match(claim[1].label, /시점·조건/);
  assert.match(claim[1].label, /여러 항목을 묶어 부른 말.*그 묶음 이름/);
  assert.match(claim[2].label, /바뀐 뒤 값만 있으면 그 값/);
  assert.match(claim[2].label, /각 시점/);
  const claimPair = getSlotList({ narrationType: 'interpretation', subKind: 'claim_to_value', hasSecondClaim: true, contentSwitch: ON });
  assert.deepEqual(claimPair.map((slot) => slot.key), ['source', 'target', 'value', 'target2', 'value2']);
  assert.equal(claimPair[2].maxWordCount, 10);
  assert.deepEqual(getSlotList({ narrationType: 'interpretation', subKind: 'claim_to_value', contentSwitch: OFF }).map((slot) => slot.key),
    ['target', 'value']);
  assert.equal(getSlotList({ narrationType: 'interpretation', subKind: 'value_to_meaning', contentSwitch: OFF })[1].maxWordCount, 5);
});

test('수치 조립: 근거 줄 칸은 읽지 않고, 비어 있어도 해설을 만든다', () => {
  const claim = (rawSlotMap) => assembleNarration({
    narrationType: 'interpretation', subKind: 'claim_to_value', rawSlotMap, contentSwitch: ON,
  })?.text ?? null;
  assert.equal(claim({ source: '첫 응답 시간 9.2시간 → 3.1시간', target: '첫 응답 시간', value: '9.2시간에서 3.1시간' }),
    '첫 응답 시간, 9.2시간에서 3.1시간');
  assert.equal(claim({ target: '첫 응답 시간', value: '9.2시간에서 3.1시간' }), '첫 응답 시간, 9.2시간에서 3.1시간');
  const meaning = assembleNarration({
    narrationType: 'interpretation', subKind: 'value_to_meaning', contentSwitch: ON,
    rawSlotMap: { source: '재고 회전율 73% (작년 대비)', value: '73%', frame: '작년 대비 본사 창고 재고 회전율' },
  });
  assert.equal(meaning.text, '73%는 작년 대비 본사 창고 재고 회전율을 의미');
});

test('수치 프롬프트: 켜면 값을 가르는 사실(시점·비교 상대·조건·범위의 끝)을 빠뜨리지 않게 하고 source 칸을 안내한다', () => {
  for (const subKind of ['claim_to_value', 'value_to_meaning']) {
    const on = buildInterpretationPrompt({ utterance: '크게 늘었습니다.', subKind, contentSwitch: ON });
    assert.match(on, /"source":/, subKind);
    assert.match(on, /비교 상대/, subKind);
    assert.match(on, /범위의 끝/, subKind);
    const off = buildInterpretationPrompt({ utterance: '크게 늘었습니다.', subKind, contentSwitch: OFF });
    assert.doesNotMatch(off, /"source":|범위의 끝/, subKind);
  }
});

test('출력 형식(영어): 새 칸도 영어 설명이고 한글이 없으며, 영어 지시 해설도 caption 뒤에 fact 를 잇는다', () => {
  for (const [narrationType, subKind] of [['deixis', 'simple'], ['deixis', 'complete'], ['interpretation', 'value_to_meaning'],
    ['interpretation', 'claim_to_value']]) {
    const english = buildSlotOutputInstruction({ narrationType, subKind, language: 'en', contentSwitch: ON });
    assert.ok(!HANGUL_PATTERN.test(english), `${narrationType}/${subKind}`);
  }
  assert.match(buildSlotOutputInstruction({ narrationType: 'deixis', subKind: 'simple', language: 'en', contentSwitch: ON }), /"fact": /);
  assert.equal(assembleNarration({
    narrationType: 'deixis', subKind: 'simple', language: 'en', contentSwitch: ON,
    rawSlotMap: { seen: 'monthly sales chart, y-axis 0-800', caption: 'the monthly sales chart', fact: 'y-axis 0 to 800' },
  }).text, 'The monthly sales chart, y-axis 0 to 800');
});

test('에이전트: config 의 스위치를 프롬프트·조립에 넘긴다', async () => {
  const content = '{"seen":"월별 매출 추이 그래프, 세로축 0~800","caption":"월별 매출 추이 그래프","fact":"세로축 0~800"}';
  const config = { vlmUrl: 'http://x', vlmModel: 'm' };
  let promptList = mockVlm(content);
  const on = await createDeixisResolutionAgent({ config: { ...config, contentSwitch: ON } }).generate({
    jpegBuffer: Buffer.from('x'), utterance: '여기 보시면', subKind: 'simple',
  });
  assert.equal(on.text, '월별 매출 추이 그래프, 세로축 0~800');
  assert.match(promptList[0], /"fact":/);
  promptList = mockVlm(content);
  const off = await createDeixisResolutionAgent({ config: { ...config, contentSwitch: OFF } }).generate({
    jpegBuffer: Buffer.from('x'), utterance: '여기 보시면', subKind: 'simple',
  });
  assert.equal(off.text, '월별 매출 추이 그래프');
  assert.doesNotMatch(promptList[0], /"fact":/);

  promptList = mockVlm('{"source":"첫 응답 시간 9.2시간 → 3.1시간","target":"첫 응답 시간","value":"9.2시간에서 3.1시간"}');
  const claim = await createInterpretiveBridgeAgent({ config: { ...config, contentSwitch: ON } }).generate({
    jpegBuffer: Buffer.from('x'), utterance: '훨씬 빨라졌습니다.', subKind: 'claim_to_value', minWordCount: 6, maxWordCount: 12,
  });
  assert.equal(claim.text, '첫 응답 시간, 9.2시간에서 3.1시간');
  assert.match(promptList[0], /"source":/);
});

test('칸 해설 파싱도 스위치를 조립에 넘긴다', () => {
  const content = '{"seen":"s","caption":"월별 매출 추이 그래프","fact":"세로축 0~800"}';
  const option = { content, narrationType: 'deixis', subKind: 'simple', maxChars: 60, maxWordCount: 10 };
  assert.equal(parseSlotCaption({ ...option, contentSwitch: ON }).text, '월별 매출 추이 그래프, 세로축 0~800');
  assert.equal(parseSlotCaption({ ...option, contentSwitch: OFF }).text, '월별 매출 추이 그래프');
});
