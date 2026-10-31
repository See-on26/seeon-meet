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
    assert.doesNotMatch(prompt, /이미 안내/, subKind);
    assert.match(prompt, /대상의 이름.*화면에서 읽어 반드시 밝힌다/, subKind);
    assert.doesNotMatch(prompt, /발화 모사/, subKind);
    assert.doesNotMatch(prompt, /발화가 대상의 내용까지|이름 글자가 발화에|진행 발화|문장이 끊겼|\(다\)/, subKind);
  }
});

// 앞선 해설 목록을 주면 그 해설의 이름·연도를 이번 화면 해설에 옮겨 적는다. 겹친 해설은 재생 전 중복 거르기가 맡는다.
test('지시 대상 프롬프트는 이미 안내된 해설 목록을 모델에 보이지 않는다', () => {
  const prompt = buildGroundingPrompt({ utterance: '', maxChars: 60, subKind: 'simple', describedElementList: ['슬라이드 1: 지점 현황'] });
  assert.doesNotMatch(prompt, /지점 현황/);
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

// 수치 해설에 같은 화면의 OCR 글자를 근거로 넣는다(값·항목 이름의 철자 확인용, 짝은 이미지에서).
// 실측 때 프롬프트에 끼운 모양 그대로 "청자는 화면을 볼 수 없다." 바로 앞에 덩어리와 빈 줄을 넣는다.
const { buildScreenTextBlock } = require('../src/main/caption-pipeline/prompts/screen-text-block.js');
const { createDeixisResolutionAgent } = require('../src/main/caption-pipeline/agents/deixis-resolution-agent.js');

const LISTENER_LINE = '청자는 화면을 볼 수 없다.';
const screenLineList = [
  { text: '국내 개발 현황', score: 0.95 }, { text: '·체험단 모집 및 단말기 배포 제주 ·79개 RSU 설치', score: 0.93 },
  { text: 'WAVE 단말기 3,000개', score: 0.9 },
];

test('수치 프롬프트: 같은 화면 OCR 줄이 있으면 "청자는 화면을 볼 수 없다." 바로 앞에 덩어리를 넣는다', () => {
  for (const subKind of ['claim_to_value', 'value_to_meaning']) {
    const utterance = '특히 장비가 크게 늘었습니다.';
    const base = buildInterpretationPrompt({ utterance, subKind });
    const withScreenText = buildInterpretationPrompt({ utterance, subKind, screenLineList });
    const block = buildScreenTextBlock({
      lineList: screenLineList, keywordSourceList: [utterance], isClaimToValue: subKind === 'claim_to_value',
    }).text;
    assert.ok(block, subKind);
    assert.equal(withScreenText, base.replace(LISTENER_LINE, `${block}\n\n${LISTENER_LINE}`), subKind);
    assert.ok(withScreenText.indexOf('글자 인식기(OCR)') < withScreenText.indexOf(LISTENER_LINE), subKind);
  }
});

test('수치 프롬프트: 변화·비교에만 "숫자 줄이 있으면 NONE 을 내지 않는다" 문장, 값→의미에는 짚기도 없다', () => {
  const claim = buildInterpretationPrompt({ utterance: '장비가 크게 늘었습니다.', subKind: 'claim_to_value', screenLineList });
  assert.match(claim, /화면 글자에 숫자가 있는 줄이 2개 있다/);
  const meaning = buildInterpretationPrompt({ utterance: '79개, 이 숫자가 의미가 큽니다.', subKind: 'value_to_meaning', screenLineList });
  assert.match(meaning, /글자 인식기\(OCR\)/);
  assert.doesNotMatch(meaning, /숫자가 있는 줄이|적힌 줄/);
});

test('OCR 줄이 없거나 비면 수치 프롬프트는 지금과 글자 하나까지 같다', () => {
  for (const subKind of ['claim_to_value', 'value_to_meaning', null]) {
    for (const language of ['ko', 'en']) {
      const base = buildInterpretationPrompt({ utterance: '크게 늘었습니다.', subKind, language, mergedClaimList: ['방문자도 늘었습니다'] });
      for (const emptyList of [undefined, null, [], [{ text: '' }, { text: '   ' }]]) {
        assert.equal(
          buildInterpretationPrompt({ utterance: '크게 늘었습니다.', subKind, language, mergedClaimList: ['방문자도 늘었습니다'], screenLineList: emptyList }),
          base, `${subKind}/${language}/${JSON.stringify(emptyList)}`,
        );
      }
      assert.doesNotMatch(base, /글자 인식기/);
    }
  }
});

// 지시 대상에 OCR 글자를 넣으면 옆 상자의 숫자를 대상에 붙였다(제주 영역 5/5 → 0/5). 지시 쪽은 받지 않는다.
test('지시 프롬프트·에이전트는 OCR 줄을 받지 않는다', async () => {
  for (const subKind of ['simple', 'complete']) {
    const base = buildGroundingPrompt({ utterance: '여기 이 지역도', maxChars: 60, subKind, hasPointingRegion: true });
    assert.equal(buildGroundingPrompt({ utterance: '여기 이 지역도', maxChars: 60, subKind, hasPointingRegion: true, screenLineList }), base);
    assert.doesNotMatch(base, /글자 인식기/);
  }
  const originalFetch = globalThis.fetch;
  const promptList = [];
  globalThis.fetch = async (_url, option) => {
    promptList.push(JSON.stringify(JSON.parse(option.body)));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"seen":"제주 지역","caption":"제주 지역"}' } }] }) };
  };
  try {
    await createDeixisResolutionAgent({ config: { vlmUrl: 'http://x', vlmModel: 'm' } }).generate({
      jpegBuffer: Buffer.from('x'), utterance: '여기 이 지역도 시범사업 들어가 있습니다', subKind: 'simple', screenLineList,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(promptList.length, 1);
  assert.doesNotMatch(promptList[0], /글자 인식기|79개 RSU/);
});

// 발화 ROI 로 확대 그림을 둘째 장으로 붙여도 지시 프롬프트에는 OCR 줄 글을 넣지 않는다. 확대 안내에 들어가는 낱말은 발화에서 온 말뿐이다.
test('지시 프롬프트: 확대 그림 두 장 안내가 붙어도 OCR 줄은 받지 않는다', () => {
  for (const zoomKind of ['speech', 'pointing', 'merged']) {
    for (const subKind of ['simple', 'complete']) {
      const args = { utterance: '여기 이 지역도', maxChars: 60, subKind, hasPointingRegion: true, zoomKind, zoomTerm: '지역' };
      const base = buildGroundingPrompt(args);
      assert.equal(buildGroundingPrompt({ ...args, screenLineList }), base, `${zoomKind}/${subKind}`);
      assert.match(base, /둘째 이미지/, `${zoomKind}/${subKind}`);
      assert.doesNotMatch(base, /글자 인식기|79개 RSU|WAVE|단말기/, `${zoomKind}/${subKind}`);
    }
  }
});
