import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ROUTER_PROMPT_MAP, JUDGE_GROUP_MAP, readJudgeGroup,
} = require('../src/main/caption-pipeline/prompts/unified-router.js');
const { createUnifiedRouter } = require('../src/main/caption-pipeline/router/unified-router.js');

// QA 2-7: 지시 대상(지시대명사·형용사+지시 명사)과 발화 기반(단순 수치·변화·척도)은 공백 기준이 서로 반대로 움직인다
// (10/15 지시 FP 45·43, 단순 수치 FN 42). 판단 지시문을 둘로 나눠 따로 맞춘다.
const DEIXIS_TYPE_LIST = ['demonstrative', 'adjective_noun'];
const SPEECH_TYPE_LIST = ['number', 'change', 'scale'];

test('트리거 유형마다 판단 묶음이 하나로 정해진다', () => {
  for (const type of DEIXIS_TYPE_LIST) assert.equal(readJudgeGroup(type), JUDGE_GROUP_MAP.deixis, type);
  for (const type of SPEECH_TYPE_LIST) assert.equal(readJudgeGroup(type), JUDGE_GROUP_MAP.speech, type);
  assert.equal(readJudgeGroup('unknown'), null);
});

test('지시 대상 지시문은 지시 유형 기준만, 발화 기반 지시문은 수치·변화·척도 기준만 담는다', () => {
  const deixisPrompt = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.deixis].systemPrompt;
  const speechPrompt = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.speech].systemPrompt;
  assert.match(deixisPrompt, /· 지시대명사\(/);
  assert.match(deixisPrompt, /· 형용사 \+ 지시 명사\(/);
  assert.match(deixisPrompt, /지시 대상 원칙/);
  for (const label of ['· 단순 수치(', '· 변화·비교·결론(', '· 추상적 척도(']) assert.equal(deixisPrompt.includes(label), false, label);

  assert.match(speechPrompt, /· 단순 수치\(/);
  assert.match(speechPrompt, /· 변화·비교·결론\(/);
  assert.match(speechPrompt, /· 추상적 척도\(/);
  assert.match(speechPrompt, /비교 대상의 이름만 있으면 근거가 아니다/);
  for (const label of ['· 지시대명사(', '· 형용사 + 지시 명사(', '지시 대상 원칙']) assert.equal(speechPrompt.includes(label), false, label);

  for (const prompt of [deixisPrompt, speechPrompt]) {
    assert.match(prompt, /애매하면 내보내지 않는다/);
    assert.match(prompt, /너는 화면을 볼 수 없다/);
    assert.match(prompt, /\{"judgeList":\[\{"id":1,"reason":"…","evidence":"…","gap":"X"\}\]\}/);
  }
});

test('few-shot 은 자기 묶음 유형의 예시만 담고, 두 묶음을 합치면 예시를 하나도 잃지 않는다', () => {
  const deixisList = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.deixis].fewShotList;
  const speechList = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.speech].fewShotList;
  for (const example of deixisList) assert.ok(example.input.candidateList.every((c) => DEIXIS_TYPE_LIST.includes(c.type)));
  for (const example of speechList) assert.ok(example.input.candidateList.every((c) => SPEECH_TYPE_LIST.includes(c.type)));
  assert.equal(deixisList.length + speechList.length, 16);
  assert.ok(deixisList.length >= 4 && speechList.length >= 8);
});

function createFakeJudgeLlm(answerByGroup) {
  const requestList = [];
  return {
    requestList,
    requestText: async (request) => {
      requestList.push(request);
      const group = request.systemPrompt === ROUTER_PROMPT_MAP.deixis.systemPrompt ? 'deixis' : 'speech';
      const answer = answerByGroup[group];
      if (answer instanceof Error) throw answer;
      return { text: answer, source: 'gpu' };
    },
  };
}

const config = { judgeBackend: 'gpu' };
const lastUserText = (request) => request.messageList.at(-1).content[0].text;

test('한 묶음 후보만 있으면 그 묶음 지시문으로 한 번만 묻는다', async () => {
  const judgeLlm = createFakeJudgeLlm({ deixis: '{"judgeList":[{"id":1,"gap":"O","evidence":"","reason":"없다"}]}' });
  const router = createUnifiedRouter({ config, judgeLlm });
  const routed = await router.route({ utterance: '이 막대를 보시면', candidateList: [{ type: 'demonstrative', phrase: '이 막대', start: 0, end: 4 }] });
  assert.equal(judgeLlm.requestList.length, 1);
  assert.equal(judgeLlm.requestList[0].systemPrompt, ROUTER_PROMPT_MAP.deixis.systemPrompt);
  assert.equal(routed.candidateList[0].type, 'deixis');
});

test('두 묶음이 섞이면 동시에 따로 묻고, 묶음 안 번호를 원래 후보에 되돌려 붙인다', async () => {
  const judgeLlm = createFakeJudgeLlm({
    deixis: '{"judgeList":[{"id":1,"gap":"X","evidence":"","reason":"앞에서 밝혔다"}]}',
    speech: '{"judgeList":[{"id":1,"gap":"O","evidence":"","reason":"무엇의 수치인지 없다"},{"id":2,"gap":"O","evidence":"","reason":"값이 없다"}]}',
  });
  const router = createUnifiedRouter({ config, judgeLlm });
  const routed = await router.route({
    utterance: '여기 30%가 많이 올랐습니다',
    candidateList: [
      { type: 'number', phrase: '30%', start: 3, end: 6 },
      { type: 'demonstrative', phrase: '여기', start: 0, end: 2 },
      { type: 'change', phrase: '많이 올랐습니다', start: 8, end: 15 },
    ],
  });
  assert.equal(judgeLlm.requestList.length, 2);
  const speechRequest = judgeLlm.requestList.find((request) => request.systemPrompt === ROUTER_PROMPT_MAP.speech.systemPrompt);
  assert.match(lastUserText(speechRequest), /1\) \[단순 수치\] "30%"\n2\) \[변화·비교·결론\] "많이 올랐습니다"/);
  assert.doesNotMatch(lastUserText(speechRequest), /\[지시대명사\]/);
  assert.deepEqual(routed.judgeList.map((entry) => [entry.id, entry.phrase, entry.isGap]), [
    [1, '30%', true], [2, '여기', false], [3, '많이 올랐습니다', true],
  ]);
  assert.deepEqual(routed.candidateList.map((entry) => entry.anchor), ['30%', '많이 올랐습니다']);
});

test('한 묶음 판단이 실패해도 다른 묶음 판단은 쓰고, 실패한 묶음 후보는 해설하지 않는다', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const judgeLlm = createFakeJudgeLlm({
      deixis: new Error('timeout'),
      speech: '{"judgeList":[{"id":1,"gap":"O","evidence":"","reason":"값이 없다"}]}',
    });
    const router = createUnifiedRouter({ config, judgeLlm });
    const routed = await router.route({
      utterance: '여기가 많이 올랐습니다',
      candidateList: [{ type: 'demonstrative', phrase: '여기', start: 0, end: 2 }, { type: 'change', phrase: '많이 올랐습니다', start: 4, end: 11 }],
    });
    assert.deepEqual(routed.candidateList.map((entry) => entry.anchor), ['많이 올랐습니다']);
    assert.equal(routed.judgeList[0].isGap, false);
    assert.match(routed.judgeList[0].reason, /judge_error/);
    assert.equal(routed.blockedReason, null);

    const allFail = createUnifiedRouter({ config, judgeLlm: createFakeJudgeLlm({ deixis: new Error('a'), speech: new Error('b') }) });
    const failed = await allFail.route({
      utterance: '여기가 많이 올랐습니다',
      candidateList: [{ type: 'demonstrative', phrase: '여기', start: 0, end: 2 }, { type: 'change', phrase: '많이 올랐습니다', start: 4, end: 11 }],
    });
    assert.equal(failed.blockedReason, 'judge_error');
    assert.equal(failed.source, 'error');
    assert.deepEqual(failed.candidateList, []);
  } finally {
    console.error = originalError;
  }
});

test('발화 기반 묶음의 X 판단도 근거 구절이 발화에 있어야 믿는다', async () => {
  const judgeLlm = createFakeJudgeLlm({ speech: '{"judgeList":[{"id":1,"gap":"X","evidence":"작년보다 늘었다","reason":"밝혔다"}]}' });
  const router = createUnifiedRouter({ config, judgeLlm });
  const routed = await router.route({ utterance: '매출이 많이 올랐습니다', candidateList: [{ type: 'change', phrase: '많이 올랐습니다', start: 4, end: 11 }] });
  assert.equal(routed.judgeList[0].isGap, true);
  assert.match(routed.judgeList[0].reason, /근거 확인 실패/);
});

test('예시 답과 출력 형식은 이유·근거를 먼저, O/X 를 마지막에 적는다', async () => {
  const { buildFewShotMessageList } = require('../src/main/caption-pipeline/prompts/unified-router.js');
  for (const group of Object.values(JUDGE_GROUP_MAP)) {
    const answerList = buildFewShotMessageList({ group }).filter((message) => message.role === 'assistant');
    for (const answer of answerList) {
      for (const entry of JSON.parse(answer.content[0].text).judgeList) {
        assert.deepEqual(Object.keys(entry), ['id', 'reason', 'evidence', 'gap']);
      }
    }
  }
});
