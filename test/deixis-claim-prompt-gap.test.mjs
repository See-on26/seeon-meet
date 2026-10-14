import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildGroundingPrompt } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');
const { getSlotList, assembleNarration } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');

// 10/15 실시간 시연: "여기 이 지역도 시범사업 들어가 있습니다" + 제주를 가리킴 → 판단·라우터는 통과했는데
// 지시 대상 에이전트가 "발화가 내용까지 말했다"로 보고 NONE. 빠진 정보는 "어느 지역인지(이름)"였다.
test('지시 대상 프롬프트는 성질·상태만 말하고 대상이 무엇인지 말하지 않은 발화를 버리지 않게 한다', () => {
  for (const subKind of ['simple', 'complete']) {
    const prompt = buildGroundingPrompt({ utterance: '', maxChars: 60, subKind });
    assert.match(prompt, /이름만 말한 것은 \(가\)가 아니다/);
    assert.match(prompt, /성질·상태만 말하고 대상이 무엇인지 말하지 않은 것도 \(가\)가 아니다/, subKind);
    assert.match(prompt, /화면에서 대상 이름을 읽어/, subKind);
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

// 실제 VLM 거절 이유(10/15): 제주를 가리켜도 "시범 사업에 들어가 있다는 내용을 이미 말함 → (가)" 10/10,
// "특히 장비가 크게 늘었습니다"는 "이전 값이 없어 변화의 근거 값을 못 댐" 10/10.
test('지시어로만 가리킨 대상은 성질을 말해도 (가)가 아니고, 발화 모사는 화면에 없어도 된다고 알린다', () => {
  const prompt = buildGroundingPrompt({ utterance: '', maxChars: 60, subKind: 'complete' });
  assert.match(prompt, /이름 글자가 발화에 없으면 청자는 대상이 어느 것인지 모른다/);
  assert.match(prompt, /\(가\) ②에서 대상의 이름 글자가 발화에 그대로 나왔고/);
  assert.match(prompt, /지시어\("여기·이·이쪽·이 지역"\)로만 대상을 가리켰다면/);
  assert.match(prompt, /발화 모사.*화면에 없어도 된다/);
});

test('변화 수치는 바뀐 뒤 값만 있어도 그 값을 근거로 쓰고, 이전 값이 없다는 이유로 거절하지 않게 한다', () => {
  const prompt = buildInterpretationPrompt({ utterance: '가입자가 크게 늘었습니다.', subKind: 'claim_to_value' });
  assert.match(prompt, /바뀐 뒤 값만 있으면 그 값을 근거로 쓴다/);
  assert.match(prompt, /이전 값이 없다는 이유로 "NONE"을 내지 않는다/);
  assert.match(prompt, /관련된 숫자가 하나라도 있으면 "NONE"을 내지 않는다/);
  assert.doesNotMatch(prompt, /양쪽 수치/);
  const valueSlot = getSlotList({ narrationType: 'interpretation', subKind: 'claim_to_value' }).find((slot) => slot.key === 'value');
  assert.match(valueSlot.label, /바뀐 뒤 값만 있으면 그 값/);
});
