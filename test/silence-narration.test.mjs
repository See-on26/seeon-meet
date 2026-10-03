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

const cueVerdict = { hasCue: true, reason: 'presenting', source: 'bedrock' };
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
  const judge = createFakeJudge({ hasCue: false, reason: 'no_cue', source: 'bedrock' });
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
