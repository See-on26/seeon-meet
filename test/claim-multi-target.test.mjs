import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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

const vlmConfig = { vlmUrl: 'http://x', vlmModel: 'm', bedrockApiKey: '' };
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
