import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectGeneratableCandidate } = require('../src/main/caption-pipeline/orchestrator/candidate-selector.js');
const { resolveNarrationEventVideoTimeMs, toNarrationCandidateList } = require('../src/main/caption-pipeline/router/unified-router.js');
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');
const {
  assembleNarration, getSlotList, ENGLISH_WORD_SCALE,
} = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { createInterpretiveBridgeAgent } = require('../src/main/caption-pipeline/agents/interpretive-bridge-agent.js');
const { approximateChartNarration, readFirstPairArgs } = require('../src/main/caption-pipeline/orchestrator/value-presence.js');

// 한 발화에 단위 없는 수치 둘("보시면 10.9, 9.3")이 모두 공백(O)으로 확정됐는데, 값→의미 에이전트는 둘째 수치를 모른 채
// 발화 전체만 받아 한 값("9.3은 …")만 해설했다. 같은 그래프의 같은 측정량이면 두 수치를 해설 하나에 담는다.
const valueJudgeList = [
  { type: 'number', phrase: '5g', isGap: false, eventVideoTimeMs: 9000 },
  { type: 'number', phrase: '10.9', isGap: true, eventVideoTimeMs: 10900 },
  { type: 'number', phrase: '9.3', isGap: true, eventVideoTimeMs: 11600 },
];

test('단순 수치 후보가 둘이면 첫 후보를 고르고 둘째 수치를 함께 넘긴다', () => {
  const { selected } = selectGeneratableCandidate({ candidateList: toNarrationCandidateList(valueJudgeList) });
  assert.equal(selected.subKind, 'value_to_meaning');
  assert.equal(selected.anchor, '10.9');
  assert.deepEqual(selected.mergedValueList, ['9.3']);
});

test('단순 수치 후보가 하나면 둘째 수치를 넘기지 않는다', () => {
  const { selected } = selectGeneratableCandidate({ candidateList: toNarrationCandidateList(valueJudgeList.slice(0, 2)) });
  assert.equal(selected.anchor, '10.9');
  assert.equal(selected.mergedValueList, undefined);
});

test('둘째 수치까지 해설하면 해설 자리는 둘째 수치를 말한 뒤다', () => {
  const { selected } = selectGeneratableCandidate({ candidateList: toNarrationCandidateList(valueJudgeList) });
  assert.equal(resolveNarrationEventVideoTimeMs({ judgeList: valueJudgeList, selectedCandidate: selected, fallbackMs: 9000 }), 11600);
});

// 프롬프트

const pairUtterance = '방문객이 꽤 늘었어요. 보시면 320, 140이에요.';

test('수치가 둘 이상이면 프롬프트가 확정된 수치를 모두 알리고 짝 칸(value2·label·label2)을 받는다', () => {
  const prompt = buildInterpretationPrompt({ utterance: pairUtterance, subKind: 'value_to_meaning', spokenValueList: ['320', '140'] });
  assert.match(prompt, /발표자는 수치를 여럿 말했다: "320", "140"\./);
  assert.match(prompt, /같은 그래프·표에서 한 측정량을 항목/);
  assert.match(prompt, /"value2"/);
  assert.match(prompt, /"label"/);
  assert.match(prompt, /"label2"/);
  assert.match(prompt, /서로 다른 대상의 값이면 첫 수치만 쓰고/);
  assert.match(prompt, /가를 수 없으면 "label"·"label2"는 빈 문자열/);
});

test('수치가 하나면 프롬프트는 예전과 글자 하나까지 같다', () => {
  const single = buildInterpretationPrompt({ utterance: '이 73%라는 숫자가 예사 숫자가 아닙니다', subKind: 'value_to_meaning' });
  assert.equal(single, buildInterpretationPrompt({
    utterance: '이 73%라는 숫자가 예사 숫자가 아닙니다', subKind: 'value_to_meaning', spokenValueList: [],
  }));
  assert.equal(single, buildInterpretationPrompt({
    utterance: '이 73%라는 숫자가 예사 숫자가 아닙니다', subKind: 'value_to_meaning', spokenValueList: ['73%'],
  }));
  assert.doesNotMatch(single, /value2|label2|여럿 말했다/);
});

test('주장→값 프롬프트는 수치 목록을 받아도 바뀌지 않는다', () => {
  const claim = buildInterpretationPrompt({ utterance: '매출이 늘었습니다.', subKind: 'claim_to_value' });
  assert.equal(claim, buildInterpretationPrompt({ utterance: '매출이 늘었습니다.', subKind: 'claim_to_value', spokenValueList: ['3', '4'] }));
});

test('값→의미 짝 프롬프트 예시에는 시연 영상 문장이 들어 있지 않다', () => {
  const prompt = buildInterpretationPrompt({ utterance: pairUtterance, subKind: 'value_to_meaning', spokenValueList: ['320', '140'] });
  for (const word of ['소금', '섭취', '10.9', '9.3', '남성', '여성', '권장량']) assert.equal(prompt.includes(word), false, word);
});

// 칸 목록

const ON = { isFactCompleteEnabled: true, isTimeMarkEnabled: true, isScreenValueFirstEnabled: true, isScaleValueFirstEnabled: true };
const OFF = { ...ON, isFactCompleteEnabled: false };

test('값→의미 짝 칸: 첫 값 뒤에 항목(label)·둘째 값(value2)·둘째 항목(label2)을 두고, 수치가 하나면 칸 목록은 그대로다', () => {
  const pair = getSlotList({ narrationType: 'interpretation', subKind: 'value_to_meaning', hasSecondClaim: true, contentSwitch: ON });
  assert.deepEqual(pair.map((slot) => slot.key), ['source', 'value', 'label', 'value2', 'label2', 'frame']);
  for (const key of ['label', 'value2', 'label2']) {
    const slot = pair.find((item) => item.key === key);
    assert.equal(slot.minWordCount, 0, key);
    assert.equal(slot.maxWordCount, 2, key);
    assert.equal(Boolean(slot.mustContainValue), false, `${key}: 비어도 해설을 버리지 않는다`);
  }
  assert.match(pair.find((slot) => slot.key === 'frame').label, /두 수치가 함께 속한 측정량/);
  assert.deepEqual(getSlotList({ narrationType: 'interpretation', subKind: 'value_to_meaning', contentSwitch: ON }).map((slot) => slot.key),
    ['source', 'value', 'frame']);
  assert.deepEqual(getSlotList({ narrationType: 'interpretation', subKind: 'value_to_meaning', hasSecondClaim: true, contentSwitch: OFF })
    .map((slot) => slot.key), ['value', 'label', 'value2', 'label2', 'frame']);
});

test('값→의미 짝 칸: 영어는 같은 칸 이름에 영어 설명, 단어 상한은 1.9배', () => {
  const korean = getSlotList({ narrationType: 'interpretation', subKind: 'value_to_meaning', hasSecondClaim: true, contentSwitch: ON });
  const english = getSlotList({ narrationType: 'interpretation', subKind: 'value_to_meaning', hasSecondClaim: true, contentSwitch: ON, language: 'en' });
  assert.deepEqual(english.map(({ key, maxWordCount }) => ({ key, maxWordCount })),
    korean.map(({ key, maxWordCount }) => ({ key, maxWordCount: Math.ceil(maxWordCount * ENGLISH_WORD_SCALE) })));
  for (const slot of english) assert.ok(!/[가-힣]/.test(slot.label), `${slot.key} 영어 설명`);
});

// 조립

const assemblePair = (rawSlotMap, option = {}) => assembleNarration({
  narrationType: 'interpretation', subKind: 'value_to_meaning', rawSlotMap, hasSecondClaim: true, ...option,
})?.text ?? null;

test('값→의미 짝: 두 항목 이름이 있으면 "A는 x, B는 y 측정량을 의미"로 읽는다', () => {
  assert.equal(assemblePair({ value: '10.9', label: '남성', value2: '9.3', label2: '여성', frame: '소금 섭취 현황' }),
    '10.9는 남성, 9.3은 여성 소금 섭취 현황을 의미');
  assert.equal(assemblePair({ source: '지역별 방문객 수 서울 320명 부산 140명', value: '320명', label: '서울', value2: '140명', label2: '부산', frame: '방문객 수' },
    { contentSwitch: ON }), '320명은 서울, 140명은 부산 방문객 수를 의미');
});

test('값→의미 짝: 항목 이름을 가를 수 없으면 "A, B는 측정량을 의미"로 두 값을 함께 읽는다', () => {
  assert.equal(assemblePair({ value: '10.9', label: '', value2: '9.3', label2: '', frame: '성별에 따른 소금 섭취 현황' }),
    '10.9, 9.3은 성별에 따른 소금 섭취 현황을 의미');
  assert.equal(assemblePair({ value: '10.9', label: '남성', value2: '9.3', label2: '', frame: '소금 섭취 현황' }),
    '10.9, 9.3은 소금 섭취 현황을 의미', '항목 이름이 한쪽만 있으면 짝이 맞지 않으니 함께 읽는다');
});

test('값→의미 짝: 둘째 값이 비었거나 수치가 아니면 첫 값만 읽고, 첫 값의 항목 이름은 측정량 앞에 붙인다', () => {
  assert.equal(assemblePair({ value: '120억', label: '', value2: '', label2: '', frame: '2024년 연간 매출' }), '120억은 2024년 연간 매출을 의미');
  assert.equal(assemblePair({ value: '10.9', label: '남성', value2: '', label2: '', frame: '소금 섭취 현황' }), '10.9는 남성 소금 섭취 현황을 의미');
  assert.equal(assemblePair({ value: '10.9', label: '남성', value2: '꽤 많음', label2: '여성', frame: '소금 섭취 현황' }),
    '10.9는 남성 소금 섭취 현황을 의미');
});

test('값→의미 짝: 한 칸에 몰아 쓴 두 값·두 항목("10.9, 9.3" / "남성, 여성")도 짝지어 읽는다', () => {
  assert.equal(assemblePair({ value: '10.9, 9.3', label: '남성, 여성', frame: '소금 섭취 현황' }),
    '10.9는 남성, 9.3은 여성 소금 섭취 현황을 의미');
  assert.equal(assemblePair({ value: '10.9, 9.3', label: '', frame: '소금 섭취 현황' }), '10.9, 9.3은 소금 섭취 현황을 의미');
  // 숫자 안의 쉼표는 값 경계가 아니다.
  assert.equal(assemblePair({ value: '1,200명', label: '서울', frame: '신규 가입자 수' }), '1,200명은 서울 신규 가입자 수를 의미');
});

test('값→의미 짝: 전체 예산을 넘으면 항목 이름을 빼고, 그래도 넘으면 첫 값만 읽는다', () => {
  const slotMap = { value: '10.9', label: '남성', value2: '9.3', label2: '여성', frame: '하루 평균 소금 섭취 현황' };
  assert.equal(assemblePair(slotMap, { maxWordCount: 12 }), '10.9는 남성, 9.3은 여성 하루 평균 소금 섭취 현황을 의미');
  assert.equal(assemblePair(slotMap, { maxWordCount: 8 }), '10.9, 9.3은 하루 평균 소금 섭취 현황을 의미');
  assert.equal(assemblePair(slotMap, { maxWordCount: 6 }), '10.9는 남성 하루 평균 소금 섭취 현황을 의미');
});

test('값→의미 한 값 조립은 예전 그대로다(짝 칸 없이 "X는 …을 의미")', () => {
  const single = (rawSlotMap, option = {}) => assembleNarration({
    narrationType: 'interpretation', subKind: 'value_to_meaning', rawSlotMap, ...option,
  })?.text ?? null;
  assert.equal(single({ value: '73%', frame: '작년 대비 A사 기업가치 성장률' }), '73%는 작년 대비 A사 기업가치 성장률을 의미');
  // 짝 칸 목록이 아니면 모델이 label·value2 를 써도 읽지 않는다.
  assert.equal(single({ value: '73%', label: '서울', value2: '41%', label2: '부산', frame: '기업가치 성장률' }), '73%는 기업가치 성장률을 의미');
});

test('값→의미 짝: 영어는 "A and B mean …"(항목 이름이 있으면 "for x and y, respectively")', () => {
  const en = { language: 'en' };
  assert.equal(assemblePair({ value: '320', label: 'Seoul', value2: '140', label2: 'Busan', frame: 'daily visitors' }, en),
    '320 and 140 mean daily visitors for Seoul and Busan, respectively');
  assert.equal(assemblePair({ value: '320', label: '', value2: '140', label2: '', frame: 'daily visitors' }, en), '320 and 140 mean daily visitors');
  assert.equal(assemblePair({ value: '320', label: 'Seoul', value2: '', label2: '', frame: 'daily visitors' }, en), '320 means daily visitors for Seoul');
  assert.equal(assembleNarration({
    narrationType: 'interpretation', subKind: 'value_to_meaning', rawSlotMap: { value: '73%', frame: 'the growth rate' }, ...en,
  }).text, '73% means the growth rate');
});

// 둘째 값이 화면에 없거나 발화의 수와 멀어 둘째 쌍을 뺄 때

test('둘째 쌍을 뺄 때: 값→의미는 둘째 값·항목만 비우고 짝 칸으로 다시 조립해 첫 값의 항목 이름을 남긴다', () => {
  const slotMap = { value: '10.9', label: '남성', value2: '9.3', label2: '여성', frame: '소금 섭취 현황' };
  const valueArgs = readFirstPairArgs({ subKind: 'value_to_meaning', slotMap });
  assert.equal(valueArgs.hasSecondClaim, true);
  assert.equal(valueArgs.rawSlotMap.value2, '');
  assert.equal(valueArgs.rawSlotMap.label2, '');
  assert.equal(assembleNarration({ narrationType: 'interpretation', subKind: 'value_to_meaning', ...valueArgs }).text,
    '10.9는 남성 소금 섭취 현황을 의미');
  // 주장→값은 예전처럼 둘째 대상·값을 비우고 첫 쌍 칸 목록으로 다시 조립한다.
  const claimArgs = readFirstPairArgs({ subKind: 'claim_to_value', slotMap: { target: '매출', value: '10억에서 12억', target2: '방문자', value2: '3천에서 5천' } });
  assert.equal(claimArgs.hasSecondClaim, false);
  assert.deepEqual(claimArgs.rawSlotMap, { target: '매출', value: '10억에서 12억', target2: '', value2: '' });
});

test('그래프 어림값으로 통과한 둘째 값에도 어림 표지를 붙여 짝 해설을 다시 조립한다', () => {
  const approximated = approximateChartNarration({
    narrationType: 'interpretation', subKind: 'value_to_meaning', hasSecondClaim: true,
    slotMap: { value: '10.9', label: '남성', value2: '9.3', label2: '여성', frame: '소금 섭취 현황' }, coreList: ['9.3'],
  });
  assert.equal(approximated.text, '10.9는 남성, 약 9.3은 여성 소금 섭취 현황을 의미');
});

// 에이전트

const vlmConfig = { vlmUrl: 'http://x', vlmModel: 'm' };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('수치 에이전트는 수치 목록을 프롬프트·짝 칸에 싣고 두 값을 담은 해설 하나를 돌려준다', async () => {
  const requestBodyList = [];
  globalThis.fetch = async (_url, option) => {
    requestBodyList.push(JSON.parse(option.body));
    const content = JSON.stringify({
      source: '성별 하루 섭취량 남성 10.9 여성 9.3', value: '10.9', label: '남성', value2: '9.3', label2: '여성', frame: '소금 섭취 현황',
    });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const result = await createInterpretiveBridgeAgent({ config: vlmConfig }).generate({
    jpegBuffer: Buffer.from('x'), utterance: '근데 보시면 10.9, 9.3', subKind: 'value_to_meaning',
    minWordCount: 6, maxWordCount: 12, spokenValueList: ['10.9', '9.3'],
  });
  assert.equal(result.text, '10.9는 남성, 9.3은 여성 소금 섭취 현황을 의미');
  assert.equal(result.slotMap.value2, '9.3');
  const promptText = JSON.stringify(requestBodyList[0]);
  assert.match(promptText, /value2/);
  assert.match(promptText, /발표자는 수치를 여럿 말했다: \\"10.9\\", \\"9.3\\"/);
});

test('수치 에이전트는 수치가 하나면 짝 칸을 싣지 않는다', async () => {
  const requestBodyList = [];
  globalThis.fetch = async (_url, option) => {
    requestBodyList.push(JSON.parse(option.body));
    const content = JSON.stringify({ value: '10.9', label: '남성', value2: '9.3', label2: '여성', frame: '소금 섭취 현황' });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const result = await createInterpretiveBridgeAgent({ config: vlmConfig }).generate({
    jpegBuffer: Buffer.from('x'), utterance: '근데 보시면 10.9', subKind: 'value_to_meaning', minWordCount: 6, maxWordCount: 12,
  });
  assert.equal(result.text, '10.9는 소금 섭취 현황을 의미');
  assert.doesNotMatch(JSON.stringify(requestBodyList[0]), /value2|label2/);
});

// main 배선

const readSource = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('main 은 합친 수치를 첫 수치와 함께 수치 목록으로 넘기고, 둘째 후보가 있으면 짝 칸·두 대상 ROI 를 쓴다', () => {
  const source = readSource('../src/main/caption-pipeline/index.js');
  assert.match(source, /const mergedValueList = selectedCandidate\?\.mergedValueList \|\| \[\];/);
  assert.match(source, /spokenValueList: mergedValueList\.length \? \[selectedCandidate\.anchor, \.\.\.mergedValueList\] : \[\]/);
  assert.match(source, /mergedClaimCount: \(selectedCandidate\?\.mergedClaimList\?\.length \|\| 0\) \+ mergedValueList\.length/);
  assert.match(source, /hasSecondClaim: isSecondPairDropped\s*\? firstPairArgs\.hasSecondClaim\s*: \(\(selectedCandidate\?\.mergedClaimList \|\| \[\]\)\.length > 0 \|\| mergedValueList\.length > 0\)/);
  assert.match(source, /slotMap: isSecondPairDropped \? firstPairArgs\.rawSlotMap : slotMap/);
});

test('main 은 값→의미 둘째 값도 발화의 수와 견주고, 둘째 쌍을 뺄 때 같은 다시 조립 인자를 쓴다', () => {
  const source = readSource('../src/main/caption-pipeline/index.js');
  const start = source.indexOf('if (slotMap?.value2 && text.includes(slotMap.value2)) {');
  assert.ok(start >= 0);
  const branch = source.slice(start, source.indexOf('// 그래프 어림값으로만 통과한 숫자는', start));
  assert.match(branch, /checkSpokenValueMatch\(\{ value: slotMap\.value2, utterance \}\)/);
  assert.match(source, /const firstPairArgs = readFirstPairArgs\(\{ subKind: selectedCandidate\?\.subKind, slotMap \}\);/);
  assert.match(branch, /const firstPair = assembleNarration\(\{\s*narrationType, subKind: selectedCandidate\?\.subKind, \.\.\.firstPairArgs,/);
  const retry = readSource('../src/main/caption-pipeline/orchestrator/screen-change-service.js');
  assert.match(retry, /readFirstPairArgs\(\{ subKind: note\.subKind, slotMap \}\)/);
  assert.match(retry, /checkSpokenValueMatch\(\{ value: slotMap\.value2, utterance: note\.utterance \}\)/);
});
