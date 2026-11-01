import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createSilenceJudge, parseSilenceJudgeText, SILENCE_JUDGE_SOURCE_MAP,
} = require('../src/main/caption-pipeline/router/silence-judge.js');
const { SILENCE_REASON_MAP } = require('../src/main/caption-pipeline/prompts/silence-judge.js');

const config = { judgeGpuUrl: 'http://gpu.test/v1/chat/completions', judgeGpuModel: 'judge-test' };

function createFakeJudgeLlm({ text = '', error = null } = {}) {
  const requestList = [];
  return {
    requestList,
    requestText: async (request) => {
      requestList.push(request);
      if (error) throw error;
      return { text, source: SILENCE_JUDGE_SOURCE_MAP.gpu };
    },
  };
}

test('cue 가 true 일 때만 단서 있음으로 본다', () => {
  assert.deepEqual(parseSilenceJudgeText('{"cue": true, "reason": "presenting"}'), {
    hasCue: true, reason: SILENCE_REASON_MAP.presenting,
  });
  assert.equal(parseSilenceJudgeText('{"cue": false, "reason": "ending"}').hasCue, false);
});

test('형식이 어긋나면 애매한 것으로 보고 차단한다', () => {
  assert.equal(parseSilenceJudgeText('true').hasCue, false);
  assert.equal(parseSilenceJudgeText('{"cue": "true"}').hasCue, false);
  assert.equal(parseSilenceJudgeText('').hasCue, false);
  assert.equal(parseSilenceJudgeText(null).hasCue, false);
});

test('코드 블록으로 감싼 JSON 도 읽는다', () => {
  assert.equal(parseSilenceJudgeText('```json\n{"cue": true, "reason": "presenting"}\n```').hasCue, true);
});

test('직전 발화가 비어 있으면 모델을 부르지 않고 차단한다', async () => {
  const judgeLlm = createFakeJudgeLlm();
  const judge = createSilenceJudge({ config, judgeLlm });
  const verdict = await judge.judge({ transcript: '   ', silenceMs: 5000 });
  assert.equal(verdict.hasCue, false);
  assert.equal(verdict.source, SILENCE_JUDGE_SOURCE_MAP.empty);
  assert.equal(judgeLlm.requestList.length, 0);
});

test('판정 LLM 에 직전 발화와 무음 길이를 보내고 gpu 경로를 남긴다', async () => {
  const judgeLlm = createFakeJudgeLlm({ text: '{"cue": true, "reason": "presenting"}' });
  const judge = createSilenceJudge({ config, judgeLlm });
  const verdict = await judge.judge({ transcript: '여러분, 이 사진을 한번 보시죠.', silenceMs: 5200 });
  assert.equal(verdict.hasCue, true);
  assert.equal(verdict.source, SILENCE_JUDGE_SOURCE_MAP.gpu);
  const [request] = judgeLlm.requestList;
  assert.ok(Number.isFinite(request.timeoutMs));
  // 상한이 작으면 JSON 이 잘려 단서가 있어도 차단된다.
  assert.ok(request.maxTokens >= 400);
  const lastMessage = request.messageList[request.messageList.length - 1];
  assert.equal(lastMessage.role, 'user');
  assert.match(lastMessage.content[0].text, /이 사진을 한번 보시죠/);
  assert.match(lastMessage.content[0].text, /5초/);
});

test('모델 호출이 실패하면 차단한다', async () => {
  const judge = createSilenceJudge({ config, judgeLlm: createFakeJudgeLlm({ error: new Error('GPU 판정(무발화 판정) HTTP 500') }) });
  const verdict = await judge.judge({ transcript: '이 그래프를 보시면요.', silenceMs: 5000 });
  assert.equal(verdict.hasCue, false);
  assert.equal(verdict.source, SILENCE_JUDGE_SOURCE_MAP.error);
  assert.match(verdict.reason, /500/);
});

const { SILENCE_JUDGE_SYSTEM_PROMPT, SILENCE_FEW_SHOT_LIST } = require('../src/main/caption-pipeline/prompts/silence-judge.js');

// 판단기를 Gemma 로 바꾼 뒤 늘어난 무발화 오탐: 녹음을 틀며 "들어 보세요", 생각·관점을 뜻하는 see·look,
// 손으로 하는 활동을 화면을 보라는 단서로 읽었다. 보라는 대상이 눈으로 볼 자료일 때만 통과시킨다.
test('무발화 판정기는 보라는 대상이 화면 자료일 때만 통과시키고, 듣기·손 활동·생각을 뜻하는 see·look 은 차단한다', () => {
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /보라는 대상이 눈으로 볼 자료\([^)]*\)여야 한다/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /"한번 보시죠"로 받아도 된다/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /카메라에 비춘 실물을 보라는 말은 화면 자료와 같다/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /"보다·see·look"이 생각·이해·관점을 뜻하면 단서가 아니다/);
  for (const idiom of ['see if', 'see what I mean', 'look at it this way', 'see eye to eye']) assert.ok(SILENCE_JUDGE_SYSTEM_PROMPT.includes(idiom), idiom);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /녹음·음성·소리를 틀어 주며 들어 보라고 해도 듣는 것이다/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /손으로 하는 활동\(만지기/);
  const blockedList = SILENCE_FEW_SHOT_LIST.filter((example) => !example.output.cue);
  assert.ok(blockedList.some((example) => /녹음/.test(example.input.transcript) && /들어 보/.test(example.input.transcript)), '녹음을 틀며 들어 보라는 차단 예시');
  assert.ok(blockedList.some((example) => /see if/.test(example.input.transcript)), '생각을 뜻하는 see 차단 예시');
  assert.ok(blockedList.some((example) => /listen/.test(example.input.transcript)), '영어 듣기 차단 예시');
  assert.ok(blockedList.some((example) => /만져/.test(example.input.transcript)), '손 활동 차단 예시');
});

test('단서는 침묵 바로 앞 마지막 문장에 있어야 한다 — 보라고 한 뒤 다른 얘기로 넘어갔으면 차단 예시가 있다', () => {
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /마지막 문장/);
  const movedOnExample = SILENCE_FEW_SHOT_LIST.find((example) => /보시죠/.test(example.input.transcript) && !example.output.cue);
  assert.ok(movedOnExample);
});

// 실시간 무음 임계는 평가 정의(5초)보다 짧다. 지시문이 "5초 이상"이라 적으면 더 짧은 침묵을 의심해 차단한다.
test('무발화 판정 지시문은 침묵 길이를 못 박지 않고 입력의 길이를 보게 한다', () => {
  assert.doesNotMatch(SILENCE_JUDGE_SYSTEM_PROMPT, /5초 이상/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /길이는 입력에 있다/);
});

// "자, 여기 ~이 있습니다"처럼 방금 띄운 자료를 소개하고 멈추면 보라는 말이 없어도 그 자료를 보라는 뜻이다.
test('방금 화면에 띄운 자료를 소개하는 말로 끝나고 멈추면 단서로 본다 — 지시문 줄과 통과 예시가 있다', () => {
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /방금 화면에 띄운 자료를 소개하는 말로 끝나고 멈췄으면/);
  assert.match(SILENCE_JUDGE_SYSTEM_PROMPT, /말로 다 전한 문장/);
  const introducedList = SILENCE_FEW_SHOT_LIST.filter((example) => example.output.cue
    && /여기 .*있습니다\.$/.test(example.input.transcript) && !/보(시|세|자)/.test(example.input.transcript));
  assert.equal(introducedList.length, 1);
  assert.equal(introducedList[0].output.reason, SILENCE_REASON_MAP.presenting);
  assert.ok(introducedList[0].input.silenceMs < 5000, '실시간 임계 근처의 짧은 침묵');
  // 시연 영상의 문장을 그대로 예시로 쓰지 않는다.
  for (const example of SILENCE_FEW_SHOT_LIST) assert.doesNotMatch(example.input.transcript, /카드|이런 규칙이 있어요/);
});
