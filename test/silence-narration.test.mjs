import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildVisualDescriptionPrompt } = require('../src/main/caption-pipeline/prompts/visual-description.js');
const { NARRATION_ORIGIN_MAP } = require('../src/main/caption-pipeline/contracts/narration-class.js');
const { VISUAL_DESCRIPTION_KIND_MAP } = require('../src/main/caption-pipeline/contracts/narration-types.js');

const reaction = VISUAL_DESCRIPTION_KIND_MAP.reaction;

test('사진 단독 전환의 반응 묘사 프롬프트는 그대로다', () => {
  const prompt = buildVisualDescriptionPrompt({ subKind: reaction });
  assert.match(prompt, /방금 단독으로 제시된 사진/);
});

test('무발화 묘사 프롬프트는 화면을 보라고 한 뒤의 침묵 상황을 알리고 직전 발화를 넘긴다', () => {
  const prompt = buildVisualDescriptionPrompt({
    subKind: reaction, origin: NARRATION_ORIGIN_MAP.silence, recentTranscript: '여러분, 이 사진을 한번 보시죠.',
  });
  assert.doesNotMatch(prompt, /방금 단독으로 제시된 사진/);
  assert.match(prompt, /말없이/);
  assert.match(prompt, /이 사진을 한번 보시죠/);
  assert.match(prompt, /그대로 옮기지/);
  assert.match(prompt, /자료 종류로 끝맺/);
  assert.match(prompt, /JSON/);
});

const { createSilenceNarrator, SILENCE_RESULT_MAP } = require('../src/main/caption-pipeline/orchestrator/silence-narrator.js');
const { createSilenceNarrationGate, SILENCE_GATE_REASON_MAP } = require('../src/main/caption-pipeline/orchestrator/silence-gate.js');

function createFakeJudge(verdict) {
  const callList = [];
  return {
    callList,
    judge: async (input) => { callList.push(input); return verdict; },
  };
}

const cueVerdict = { hasCue: true, reason: 'presenting', source: 'gpu' };
const input = { slideLabel: '3', transcript: '여러분, 이 사진을 한번 보시죠.', silenceMs: 5000 };

test('단서가 있으면 묘사해 내보내고, 같은 슬라이드의 다음 무음은 막는다', async () => {
  const gate = createSilenceNarrationGate();
  const narrator = createSilenceNarrator({ gate, judge: createFakeJudge(cueVerdict) });
  const emittedList = [];
  const result = await narrator.run({
    ...input,
    describe: async () => ({ isGrounded: true, text: '이미지 제시, 야윈 어린아이 사진' }),
    emit: async ({ text }) => { emittedList.push(text); return { isEmitted: true }; },
  });
  assert.equal(result.status, SILENCE_RESULT_MAP.emitted);
  assert.deepEqual(emittedList, ['이미지 제시, 야윈 어린아이 사진']);
  assert.equal(gate.tryAcquire({ slideLabel: '3' }).reason, SILENCE_GATE_REASON_MAP.slideDone);
});

test('게이트가 막으면 판정기를 부르지 않는다', async () => {
  const gate = createSilenceNarrationGate();
  gate.tryAcquire({ slideLabel: '1' });
  const judge = createFakeJudge(cueVerdict);
  const result = await createSilenceNarrator({ gate, judge }).run({
    ...input, describe: async () => assert.fail('묘사하면 안 된다'), emit: async () => assert.fail('내보내면 안 된다'),
  });
  assert.equal(result.status, SILENCE_RESULT_MAP.gated);
  assert.equal(result.reason, SILENCE_GATE_REASON_MAP.inFlight);
  assert.equal(judge.callList.length, 0);
});

test('판정기가 차단하면 묘사하지 않고, 같은 슬라이드의 다음 무음을 허용한다', async () => {
  const gate = createSilenceNarrationGate();
  const judge = createFakeJudge({ hasCue: false, reason: 'no_cue', source: 'gpu' });
  const result = await createSilenceNarrator({ gate, judge }).run({
    ...input, describe: async () => assert.fail('묘사하면 안 된다'), emit: async () => assert.fail('내보내면 안 된다'),
  });
  assert.equal(result.status, SILENCE_RESULT_MAP.blocked);
  assert.equal(result.reason, 'no_cue');
  assert.deepEqual(judge.callList, [{ transcript: input.transcript, silenceMs: input.silenceMs }]);
  assert.equal(gate.tryAcquire({ slideLabel: '3' }).isAllowed, true);
});

test('묘사가 NONE 이면 내보내지 않는다', async () => {
  const gate = createSilenceNarrationGate();
  const result = await createSilenceNarrator({ gate, judge: createFakeJudge(cueVerdict) }).run({
    ...input, describe: async () => ({ isGrounded: false, text: '' }), emit: async () => assert.fail('내보내면 안 된다'),
  });
  assert.equal(result.status, SILENCE_RESULT_MAP.none);
  assert.equal(gate.tryAcquire({ slideLabel: '3' }).isAllowed, true);
});

test('내보내기가 거절되면(중복 억제 등) 낸 것으로 치지 않는다', async () => {
  const gate = createSilenceNarrationGate();
  const result = await createSilenceNarrator({ gate, judge: createFakeJudge(cueVerdict) }).run({
    ...input,
    describe: async () => ({ isGrounded: true, text: '이미지 제시, 야윈 어린아이 사진' }),
    emit: async () => ({ isEmitted: false }),
  });
  assert.equal(result.status, SILENCE_RESULT_MAP.dropped);
  assert.equal(gate.tryAcquire({ slideLabel: '3' }).isAllowed, true);
});

test('묘사 중 오류가 나면 실패로 돌려주고 게이트를 푼다', async () => {
  const gate = createSilenceNarrationGate();
  const result = await createSilenceNarrator({ gate, judge: createFakeJudge(cueVerdict) }).run({
    ...input, describe: async () => { throw new Error('VLM 타임아웃'); }, emit: async () => ({ isEmitted: true }),
  });
  assert.equal(result.status, SILENCE_RESULT_MAP.failed);
  assert.match(result.reason, /타임아웃/);
  assert.equal(gate.tryAcquire({ slideLabel: '3' }).isAllowed, true);
});

test('묘사 끝이 흐리면 내보내지 않고, 원문을 남긴다', async () => {
  const gate = createSilenceNarrationGate();
  const result = await createSilenceNarrator({ gate, judge: createFakeJudge(cueVerdict) }).run({
    ...input,
    describe: async () => ({ isGrounded: true, text: '이미지 제시, 검은 배경에 하얀' }),
    emit: async () => assert.fail('내보내면 안 된다'),
  });
  assert.equal(result.status, SILENCE_RESULT_MAP.none);
  assert.equal(result.rawText, '이미지 제시, 검은 배경에 하얀');
});

test('묘사는 자료 명사 지점까지 다듬어 내보낸다', async () => {
  const emittedList = [];
  await createSilenceNarrator({ gate: createSilenceNarrationGate(), judge: createFakeJudge(cueVerdict) }).run({
    ...input,
    describe: async () => ({ isGrounded: true, text: '이미지 제시, 반기 연봉 조정 그래프 제시' }),
    emit: async ({ text }) => { emittedList.push(text); return { isEmitted: true }; },
  });
  assert.deepEqual(emittedList, ['이미지 제시, 반기 연봉 조정 그래프']);
});

const { finalizeSilenceDescription } = require('../src/main/caption-pipeline/orchestrator/silence-narrator.js');

test('자료 명사로 끝나는 묘사는 그대로 둔다', () => {
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 뼈가 앙상하게 야윈 어린아이 사진' }),
    '이미지 제시, 뼈가 앙상하게 야윈 어린아이 사진');
});

test('자료 명사 뒤의 조사·군더더기는 떼고 그 지점까지 자른다', () => {
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 다양한 여행 사진과 글귀가' }), '이미지 제시, 다양한 여행 사진');
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 반기 연봉 조정 그래프 제시' }), '이미지 제시, 반기 연봉 조정 그래프');
});

test('복수형 자료 명사도 자료 명사로 본다', () => {
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 동물의 귀여운 모습이 담긴 사진들' }),
    '이미지 제시, 동물의 귀여운 모습이 담긴 사진');
});

test('형식이 깨져 머리말이 빠져도 붙여서 돌려준다', () => {
  assert.equal(finalizeSilenceDescription({ text: '팀과 구성원 보상 구조 타임라인 제시' }), '이미지 제시, 팀과 구성원 보상 구조 타임라인');
});

test('자료 명사로 끝맺을 수 없거나 너무 짧아지면 버린다', () => {
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 검은 배경에 하얀' }), null);
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 팀과 구성원이 Win-Win 할 수' }), null);
  assert.equal(finalizeSilenceDescription({ text: '' }), null);
});

test('VLM 이 쓴 "○○ 제시," 머리말은 뒷부분이 자료 명사로 끝나면 떼어 겹치지 않게 한다', () => {
  assert.equal(finalizeSilenceDescription({ text: '타임라인 제시, 팀 보상 구조가 분명한 그래프' }),
    '이미지 제시, 팀 보상 구조가 분명한 그래프');
  assert.equal(finalizeSilenceDescription({ text: '반기수시 연봉 조정 그래프 제시, 연봉 상승 폭이 큰 차이로 나타남' }),
    '이미지 제시, 반기수시 연봉 조정 그래프');
  assert.equal(finalizeSilenceDescription({ text: '타임라인 제시, 팀 보상 구조 계획이 분홍색으로 표시되어 있다' }),
    '이미지 제시, 팀 보상 구조 계획');
});

test('조사가 붙은 복수형 자료 명사도 자료 명사 지점으로 본다', () => {
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 여행과 휴양지 사진들이 나열되어 있다' }),
    '이미지 제시, 여행과 휴양지 사진');
});

test('문장 중간의 복수형 자료 명사는 건드리지 않는다', () => {
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 그래프들이 나란히 놓인 비교 화면' }),
    '이미지 제시, 그래프들이 나란히 놓인 비교 화면');
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 표들을 비교한 매출 자료' }), '이미지 제시, 표들을 비교한 매출 자료');
});

test('끝 문장부호가 붙어도 자료 명사로 끝난 것으로 본다', () => {
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 귀여운 강아지 사진.' }), '이미지 제시, 귀여운 강아지 사진');
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 여행지 풍경 사진들,' }), '이미지 제시, 여행지 풍경 사진');
});

test('무발화 프롬프트는 사진 단독용 반응·NONE 규칙 대신 보라고 한 대상 기준을 쓴다', () => {
  const silencePrompt = buildVisualDescriptionPrompt({ subKind: reaction, origin: NARRATION_ORIGIN_MAP.silence });
  assert.doesNotMatch(silencePrompt, /반응을 일으킬 만한 요소가 없는 평범한 화면/);
  assert.doesNotMatch(silencePrompt, /쓰러져있다/);
  assert.match(silencePrompt, /보라고 한 대상을 화면에서 찾을 수 없/);
  assert.match(buildVisualDescriptionPrompt({ subKind: reaction }), /반응을 일으킬 만한 요소가 없는 평범한 화면/);
});

const { getSlotList, assembleNarration } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { NARRATION_TYPE_MAP } = require('../src/main/caption-pipeline/contracts/narration-types.js');

const describedTransition = '슬라이드 3: 연도별 매출 실적과 2027년 목표치를 비교한 그래프';

test('무발화 묘사는 전환 해설이 자료 종류·주제만 말했으면 그 자료가 보여 주는 값·변화를 묘사하게 한다', () => {
  const prompt = buildVisualDescriptionPrompt({
    subKind: reaction, origin: NARRATION_ORIGIN_MAP.silence, recentTranscript: '그래프를 잠시 보시죠.',
    describedElementList: [describedTransition],
  });
  assert.match(prompt, new RegExp(describedTransition));
  assert.match(prompt, /값·변화/);
  assert.doesNotMatch(prompt, /이미 안내된 요소\(.*\)면 반복하지 말고/, '전환 해설과 대상이 같다는 이유만으로 NONE 을 내지 않는다');
});

test('사진 단독 전환의 반응 묘사는 지금처럼 이미 안내된 요소면 반복하지 않는다', () => {
  const prompt = buildVisualDescriptionPrompt({ subKind: reaction, describedElementList: [describedTransition] });
  assert.match(prompt, /이미 안내된 요소\(.*\)면 반복하지 말고/);
});

test('반응 묘사 칸은 값을 담을 수 있게 8어절까지 받는다(5어절에서 잘리면 자료 종류 꼬리가 빠져 버려진다). 무발화 칸은 따로 12어절이다', () => {
  const [slot] = getSlotList({ narrationType: NARRATION_TYPE_MAP.visualDescription, subKind: reaction });
  assert.equal(slot.maxWordCount, 8);
  const result = assembleNarration({
    narrationType: NARRATION_TYPE_MAP.visualDescription, subKind: reaction,
    rawSlotMap: { description: '9시에 96건으로 가장 많은 시간대별 문의 접수량 그래프' },
  });
  assert.equal(result?.text, '이미지 제시, 9시에 96건으로 가장 많은 시간대별 문의 접수량 그래프');
});
