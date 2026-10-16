import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildGroundingPrompt } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');
const { getSlotList, assembleNarration } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');

// 라우터(판단 LLM)가 발화를 보고 공백 O 로 넘긴 문장을 에이전트가 같은 발화로 다시 판단하면,
// 둘의 기준이 어긋날 때마다 AD 가 버려진다("여기 이 지역도 시범사업 들어가 있습니다" + 제주 → "내용까지 말함"으로 NONE).
// 발화가 이미 다 말한 문장은 라우터가 X 로 거르므로, 에이전트는 화면 근거로만 거절한다.
test('지시 대상 프롬프트는 발화를 다시 판단하지 않고 화면 근거로만 거절한다', () => {
  for (const subKind of ['simple', 'complete']) {
    const prompt = buildGroundingPrompt({ utterance: '', maxChars: 60, subKind });
    assert.match(prompt, /발화가 무엇을 말했는지 다시 따지지 말고/, subKind);
    assert.match(prompt, /가리킨 대상을 화면에서 특정할 수 없다/, subKind);
    assert.match(prompt, /"이미 안내된" 목록에 같은 대상/, subKind);
    assert.match(prompt, /대상의 이름.*화면에서 읽어 반드시 밝힌다/, subKind);
    assert.match(prompt, /발화 모사.*화면에 없어도 된다/, subKind);
    assert.doesNotMatch(prompt, /발화가 대상의 내용까지|이름 글자가 발화에|진행 발화|문장이 끊겼|\(다\)/, subKind);
  }
});

test('지시 대상 프롬프트는 슬라이드 주제만 안내된 것을 대상과 겹친다고 보지 않는다', () => {
  const prompt = buildGroundingPrompt({ utterance: '', maxChars: 60, subKind: 'simple', describedElementList: ['슬라이드 1: 지점 현황'] });
  assert.match(prompt, /목록이 슬라이드 주제만 말했다면 그 안의 대상은 아직 안내되지 않은 것이다/);
});

test('수치 프롬프트는 발표자가 이미 말했다는 이유로 거절하지 않는다', () => {
  for (const subKind of ['claim_to_value', 'value_to_meaning']) {
    const prompt = buildInterpretationPrompt({ utterance: '크게 늘었습니다.', subKind });
    assert.match(prompt, /발화가 무엇을 말했는지 다시 따지지 말고/, subKind);
    assert.doesNotMatch(prompt, /이미 말로 밝힌/, subKind);
  }
});

test('지시 대상 프롬프트 예시에 시연 슬라이드 내용을 넣지 않는다', () => {
  const prompt = buildGroundingPrompt({ utterance: '', maxChars: 60, subKind: 'complete' });
  assert.doesNotMatch(prompt, /제주|시범 ?사업/);
});

// 같은 시연: "특히 장비가 크게 늘었습니다" → 화면에는 RSU 79개·WAVE 단말기 3,000개가 있는데 "RSU 설치, 79개" 하나만 나왔다.
test('변화·비교 수치 프롬프트는 묶음 이름이면 값이 있는 항목을 2개까지 각자의 값과 함께 쓰게 한다', () => {
  const prompt = buildInterpretationPrompt({ utterance: '인력이 크게 늘었습니다.', subKind: 'claim_to_value' });
  assert.match(prompt, /여러 항목을 묶어 부르는 말/);
  assert.match(prompt, /2개까지/);
  assert.doesNotMatch(prompt, /RSU|WAVE|단말기|장비/);
  assert.doesNotMatch(buildInterpretationPrompt({ utterance: '73%입니다.', subKind: 'value_to_meaning' }), /묶어 부르는 말/);
});

test('변화·비교 해설의 값 칸은 항목 둘과 값이 들어가게 6어절까지 받는다', () => {
  const valueSlot = getSlotList({ narrationType: 'interpretation', subKind: 'claim_to_value' }).find((slot) => slot.key === 'value');
  assert.equal(valueSlot.maxWordCount, 6);
  assert.match(valueSlot.label, /묶음/);
  const assemble = (rawSlotMap) => assembleNarration({ narrationType: 'interpretation', subKind: 'claim_to_value', rawSlotMap })?.text ?? null;
  assert.equal(assemble({ target: '설치 장비', value: 'RSU 79개와 WAVE 단말기 3,000개' }), '설치 장비, RSU 79개와 WAVE 단말기 3,000개');
  assert.equal(assemble({ target: '인력', value: '개발자 120명, 디자이너 30명, 기획자 10명' }), '인력, 개발자 120명, 디자이너 30명, 기획자 10명');
});

// 실제 VLM 거절 이유(10/15): "특히 장비가 크게 늘었습니다"는 "이전 값이 없어 변화의 근거 값을 못 댐" 10/10.
test('변화 수치는 바뀐 뒤 값만 있어도 그 값을 근거로 쓰고, 이전 값이 없다는 이유로 거절하지 않게 한다', () => {
  const prompt = buildInterpretationPrompt({ utterance: '가입자가 크게 늘었습니다.', subKind: 'claim_to_value' });
  assert.match(prompt, /바뀐 뒤 값만 있으면 그 값을 근거로 쓴다/);
  assert.match(prompt, /이전 값이 없다는 이유로 "NONE"을 내지 않는다/);
  assert.match(prompt, /관련된 숫자가 하나라도 있으면 "NONE"을 내지 않는다/);
  assert.doesNotMatch(prompt, /양쪽 수치/);
  const valueSlot = getSlotList({ narrationType: 'interpretation', subKind: 'claim_to_value' }).find((slot) => slot.key === 'value');
  assert.match(valueSlot.label, /바뀐 뒤 값만 있으면 그 값/);
});

// 출력 칸 설명이 "화면에 적힌 항목 이름"만 말하면 VLM 은 본문의 "묶음 이름을 쓴다"보다 칸 설명을 따라,
// 대상 칸에 항목 이름을 넣고 값 칸에 또 써서 "RSU, WAVE 단말기, RSU 79개, …"처럼 이름이 되풀이됐다(10회 중 7회).
test('변화·비교 대상 칸 설명은 묶음 이름을 쓰라는 본문과 맞춘다', () => {
  const targetSlot = getSlotList({ narrationType: 'interpretation', subKind: 'claim_to_value' }).find((slot) => slot.key === 'target');
  assert.match(targetSlot.label, /여러 항목을 묶어 부른 말.*그 묶음 이름/);
  assert.match(targetSlot.label, /인력/);
});

test('대상 칸의 이름이 모두 값 칸에 나오면 대상 칸을 빼고 값만 읽는다', () => {
  const assemble = (rawSlotMap) => assembleNarration({ narrationType: 'interpretation', subKind: 'claim_to_value', rawSlotMap })?.text ?? null;
  assert.equal(assemble({ target: 'RSU, WAVE 단말기', value: 'RSU 79개, WAVE 단말기 3,000개' }), 'RSU 79개, WAVE 단말기 3,000개');
  assert.equal(assemble({ target: 'RSU 및 WAVE 단말기', value: 'RSU 79개, WAVE 단말기 3,000개' }), 'RSU 79개, WAVE 단말기 3,000개');
  assert.equal(assemble({ target: '첫 응답 시간', value: '9.2시간에서 3.1시간' }), '첫 응답 시간, 9.2시간에서 3.1시간');
  assert.equal(assemble({ target: '시간', value: '9.2시간에서 3.1시간' }), '시간, 9.2시간에서 3.1시간');
  assert.equal(assemble({ target: '설치 장비', value: 'RSU 79개와 WAVE 단말기 3,000개' }), '설치 장비, RSU 79개와 WAVE 단말기 3,000개');
});
