import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectGeneratableCandidate } = require('../src/main/caption-pipeline/orchestrator/candidate-selector.js');
const { resolveNarrationEventVideoTimeMs, toNarrationCandidateList } = require('../src/main/caption-pipeline/router/unified-router.js');
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');
const { assembleNarration } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { createInterpretiveBridgeAgent } = require('../src/main/caption-pipeline/agents/interpretive-bridge-agent.js');

// 한 결정(조각을 합친 한 발화)에 변화·비교 후보가 둘이면 첫 번째만 해설되고 둘째는 버려졌다.
// 실험실 A-2 "응답 속도는 작년보다 훨씬 빨라졌습니다. 만족도도 꽤 많이 올랐습니다." 13회 모두 만족도 값이 빠짐.
const claimJudgeList = [
  { type: 'change', phrase: '훨씬 빨라졌습니다', isGap: true, eventVideoTimeMs: 10000 },
  { type: 'change', phrase: '꽤 많이 올랐습니다', isGap: true, eventVideoTimeMs: 12500 },
];

test('변화 후보가 둘이면 첫 후보를 고르고 둘째 표현을 함께 넘긴다', () => {
  const { selected } = selectGeneratableCandidate({ candidateList: toNarrationCandidateList(claimJudgeList) });
  assert.equal(selected.anchor, '훨씬 빨라졌습니다');
  assert.deepEqual(selected.mergedClaimList, ['꽤 많이 올랐습니다']);
});

test('변화 후보가 하나면 둘째 표현을 넘기지 않는다', () => {
  const { selected } = selectGeneratableCandidate({ candidateList: toNarrationCandidateList([claimJudgeList[0]]) });
  assert.equal(selected.mergedClaimList, undefined);
});

test('둘째 변화까지 해설하면 해설 자리는 둘째 변화를 말한 뒤다', () => {
  const { selected } = selectGeneratableCandidate({ candidateList: toNarrationCandidateList(claimJudgeList) });
  assert.equal(resolveNarrationEventVideoTimeMs({ judgeList: claimJudgeList, selectedCandidate: selected, fallbackMs: 9000 }), 12500);
});

test('둘째 변화가 있으면 프롬프트가 다른 대상일 때만 둘째 대상·값을 쓰게 하고, 없으면 그 안내가 없다', () => {
  const withSecond = buildInterpretationPrompt({ utterance: '매출이 늘었습니다. 방문자도 늘었습니다.', subKind: 'claim_to_value', mergedClaimList: ['방문자도 늘었습니다'] });
  assert.match(withSecond, /발표자는 변화를 또 말했다: "방문자도 늘었습니다"/);
  assert.match(withSecond, /"target2"/);
  assert.match(withSecond, /같은 대상·같은 값을 다시 말한 것이면/);
  const single = buildInterpretationPrompt({ utterance: '매출이 늘었습니다.', subKind: 'claim_to_value' });
  assert.equal(single, buildInterpretationPrompt({ utterance: '매출이 늘었습니다.', subKind: 'claim_to_value', mergedClaimList: [] }));
  assert.doesNotMatch(single, /target2|또 말했다/);
  assert.doesNotMatch(withSecond, /만족도/);
});

const assemble = (rawSlotMap, option = {}) => assembleNarration({
  narrationType: 'interpretation', subKind: 'claim_to_value', rawSlotMap, hasSecondClaim: true, ...option,
})?.text ?? null;

test('둘째 대상·값이 있으면 두 쌍을 문장으로 나눠 읽는다', () => {
  assert.equal(assemble({ target: '첫 응답 시간', value: '9.2시간에서 3.1시간', target2: '고객 만족도', value2: '72점에서 88점' }),
    '첫 응답 시간, 9.2시간에서 3.1시간. 고객 만족도, 72점에서 88점');
});

test('둘째 칸이 비었거나 값이 수치가 아니면 첫 쌍만 읽는다', () => {
  const first = { target: '도심과 교외 기온', value: '33.8도와 29.1도' };
  assert.equal(assemble({ ...first, target2: '', value2: '' }), '도심과 교외 기온, 33.8도와 29.1도');
  assert.equal(assemble({ ...first, target2: '기온 차이', value2: '꽤 큼' }), '도심과 교외 기온, 33.8도와 29.1도');
  assert.equal(assemble(first), '도심과 교외 기온, 33.8도와 29.1도');
});

test('두 쌍이 어절 예산을 넘으면 첫 쌍만 읽는다', () => {
  const slotMap = { target: '첫 응답 시간', value: '9.2시간에서 3.1시간', target2: '고객 만족도', value2: '72점에서 88점' };
  assert.equal(assemble(slotMap, { maxWordCount: 6 }), '첫 응답 시간, 9.2시간에서 3.1시간');
});

const vlmConfig = { vlmUrl: 'http://x', vlmModel: 'm' };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('수치 에이전트는 둘째 변화를 프롬프트·칸에 싣고 두 쌍 해설을 돌려준다', async () => {
  const requestBodyList = [];
  globalThis.fetch = async (_url, option) => {
    requestBodyList.push(JSON.parse(option.body));
    const content = JSON.stringify({ target: '첫 응답 시간', value: '9.2시간에서 3.1시간', target2: '고객 만족도', value2: '72점에서 88점' });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const result = await createInterpretiveBridgeAgent({ config: vlmConfig }).generate({
    jpegBuffer: Buffer.from('x'), utterance: '훨씬 빨라졌습니다. 꽤 많이 올랐습니다.', subKind: 'claim_to_value',
    minWordCount: 6, maxWordCount: 12, mergedClaimList: ['꽤 많이 올랐습니다'],
  });
  assert.equal(result.text, '첫 응답 시간, 9.2시간에서 3.1시간. 고객 만족도, 72점에서 88점');
  assert.equal(result.slotMap.value2, '72점에서 88점');
  assert.match(JSON.stringify(requestBodyList[0]), /target2/);
});

// 둘째 값이 화면에 없으면 main 이 둘째 쌍을 비우고 첫 쌍만 다시 조립한다. 예산 없이 다시 조립하면
// 에이전트가 줄였던 첫 쌍("올해 상반기 신규 가입자, 서울 1,200명")이 칸 그대로 길게 되살아난다.
test('수치 에이전트는 실제로 쓴 전체 예산(언어 배율 적용값)을 돌려주고, 첫 쌍만 다시 조립할 때 그 예산으로 줄인다', async () => {
  globalThis.fetch = async () => {
    const content = JSON.stringify({
      target: '올해 상반기 신규 가입자', value: '서울 1,200명, 부산 800명, 대구 500명', target2: '탈퇴 회원', value2: '90명에서 40명',
    });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const generateArgs = {
    jpegBuffer: Buffer.from('x'), utterance: '가입자가 늘었습니다. 탈퇴는 줄었습니다.', subKind: 'claim_to_value',
    minWordCount: 2, maxWordCount: 6, mergedClaimList: ['탈퇴는 줄었습니다'],
  };
  const korean = await createInterpretiveBridgeAgent({ config: vlmConfig }).generate(generateArgs);
  assert.deepEqual(korean.appliedBudget, { maxWordCount: 6, maxChars: 30 });
  const english = await createInterpretiveBridgeAgent({ config: vlmConfig, getCaptionLanguage: () => 'en' }).generate(generateArgs);
  assert.deepEqual(english.appliedBudget, { maxWordCount: 12, maxChars: 84 });

  const reassemble = (budget) => assembleNarration({
    narrationType: 'interpretation', subKind: 'claim_to_value', rawSlotMap: { ...korean.slotMap, target2: '', value2: '' }, ...budget,
    contentSwitch: { isTimeMarkEnabled: true },
  }).text;
  assert.equal(reassemble({}), '올해 상반기 신규 가입자, 서울 1,200명, 부산 800명, 대구 500명', '예산 없이 다시 조립하면 길게 되살아난다');
  // 대상 앞 시점("올해 상반기")은 예산을 맞출 때도 남긴다(시점 표기 지키기, 기본 켜짐).
  assert.equal(reassemble(korean.appliedBudget), '올해 상반기 신규 가입자, 서울 1,200명');
});

test('main 은 둘째 값이 화면에 없어 첫 쌍만 다시 조립할 때 에이전트가 쓴 전체 예산을 넘긴다', () => {
  const source = fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('const firstPair = assembleNarration({');
  assert.ok(start >= 0);
  const call = source.slice(start, source.indexOf('});', start));
  assert.match(call, /maxWordCount: appliedBudget\?\.maxWordCount/);
  assert.match(call, /maxChars: appliedBudget\?\.maxChars/);
  assert.match(source, /appliedBudget = null,?\s*\} = await agent\.generate\(/);
});

// 실험실 A-2: 모델이 둘째 변화를 첫 값 칸에 몰아넣어("첫 응답 시간 9.2시간에서 3.1시간, 고객 만족도 72점에서 88점")
// 값 칸 6어절에서 잘리자 "…, 고객"으로 끝난 해설이 그대로 나갔다.
test('값 칸이 어절 수에서 잘리면 쉼표 뒤 수치 없는 조각은 버린다', () => {
  const text = assembleNarration({
    narrationType: 'interpretation', subKind: 'claim_to_value',
    rawSlotMap: { target: '응답 품질 변화', value: '첫 응답 시간 9.2시간에서 3.1시간, 고객 만족도 72점에서 88점' },
  })?.text;
  assert.equal(text, '응답 품질 변화, 첫 응답 시간 9.2시간에서 3.1시간');
});

test('둘째 변화가 있으면 값 칸을 넓혀 한 칸에 몰아넣은 두 값도 다 읽는다', () => {
  assert.equal(assemble({ target: '응답 품질 변화', value: '첫 응답 시간 9.2시간에서 3.1시간, 고객 만족도 72점에서 88점' }),
    '응답 품질 변화, 첫 응답 시간 9.2시간에서 3.1시간, 고객 만족도 72점에서 88점');
});

// 둘째 변화의 대상("만족도")이 글자 많은 화면 아래쪽에 있어도 600자 상한 안에 남아야 둘째 값을 화면 글자로 확인할 수 있다.
const fillerLineList = Array.from({ length: 24 }, (_, index) => ({
  text: `${String(index + 1).padStart(2, '0')}. 운영 지표 항목의 이번 달 처리 건수는 ${index + 100}건이다.`, score: 0.95,
}));
const satisfactionLine = { text: '25. 고객 만족도는 72점에서 88점으로 올랐다.', score: 0.95 };

test('둘째 변화 표현의 낱말이 든 OCR 줄도 상한 안에 먼저 넣는다', () => {
  const screenLineList = [...fillerLineList, satisfactionLine];
  const withSecond = buildInterpretationPrompt({
    utterance: '응답 속도는 훨씬 빨라졌습니다.', subKind: 'claim_to_value', mergedClaimList: ['만족도도 꽤 많이 올랐습니다'], screenLineList,
  });
  assert.ok(withSecond.includes(satisfactionLine.text));
  const single = buildInterpretationPrompt({ utterance: '응답 속도는 훨씬 빨라졌습니다.', subKind: 'claim_to_value', screenLineList });
  assert.ok(!single.includes(satisfactionLine.text), '둘째 표현이 없으면 위에서부터 600자');
});

test('수치 에이전트는 OCR 줄을 프롬프트에 싣고, 넣은 줄 수·글자 수를 돌려준다', async () => {
  const requestBodyList = [];
  globalThis.fetch = async (_url, option) => {
    requestBodyList.push(JSON.parse(option.body));
    const content = JSON.stringify({ target: '고객 만족도', value: '72점에서 88점' });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const screenLineList = [{ text: '고객 응답 품질', score: 0.95 }, satisfactionLine];
  const agent = createInterpretiveBridgeAgent({ config: vlmConfig });
  const result = await agent.generate({
    jpegBuffer: Buffer.from('x'), utterance: '만족도가 꽤 많이 올랐습니다.', subKind: 'claim_to_value',
    minWordCount: 6, maxWordCount: 12, screenLineList,
  });
  assert.equal(result.text, '고객 만족도, 72점에서 88점');
  const promptText = JSON.stringify(requestBodyList[0]);
  assert.ok(promptText.includes('글자 인식기(OCR)'));
  assert.ok(promptText.includes(satisfactionLine.text));
  assert.deepEqual(result.screenTextBlock, {
    lineCount: 2, charCount: '고객 응답 품질'.length + satisfactionLine.text.length, numberLineCount: 1,
  });
  const withoutScreenText = await agent.generate({
    jpegBuffer: Buffer.from('x'), utterance: '만족도가 꽤 많이 올랐습니다.', subKind: 'claim_to_value', minWordCount: 6, maxWordCount: 12,
  });
  assert.deepEqual(withoutScreenText.screenTextBlock, { lineCount: 0, charCount: 0, numberLineCount: 0 });
  assert.ok(!JSON.stringify(requestBodyList[1]).includes('글자 인식기'));
});
