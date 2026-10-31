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
  assert.equal(deixisList.length + speechList.length, 39);
  assert.ok(deixisList.length >= 4 && speechList.length >= 8);
});

// 같은 앞 문맥·트리거 문장에서 뒤 발화만 다른 예시 쌍을 찾는다. 규칙이 한쪽(X)으로만 기울지 않게 O 짝을 함께 둔다.
function findContrastPair({ exampleList, type, isNamed }) {
  return exampleList.filter((example) => example.input.candidateList[0].type === type).some((left) => exampleList.some((right) => right !== left
    && right.input.before === left.input.before && right.input.utterance === left.input.utterance
    && left.output.judgeList[0].gap === 'X' && right.output.judgeList[0].gap === 'O'
    && isNamed(left.input.after) && !isNamed(right.input.after)));
}

// 판단기를 Gemma 로 바꾼 뒤 늘어난 오탐: 앞에서 "두 후보의 성질이 서로 다르다"고만 한 뒤 뒤 발화가 이름을 대도
// "그 이름이 그 성질인지 말하지 않았다"며 O 를 준다. 반대로 "서로 다르다"만으로 고를 수 있다며 X 를 주는 누락도 있다.
test('형용사 + 지시 명사는 다르다는 말만으로 고르지 않고, 뒤 발화가 후보 이름을 대면 X 로 본다', () => {
  const deixisPrompt = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.deixis].systemPrompt;
  assert.match(deixisPrompt, /다르다는 것·표시 방식만 말하면 어느 것인지 정해지지 않았다/);
  assert.match(deixisPrompt, /성질이 서로 다르다"고만 했어도 마찬가지다/);
  assert.match(deixisPrompt, /"그 이름이 그 성질을 가졌다고 말하지 않았다"며 O 로 하지 마라/);
  assert.match(deixisPrompt, /실제 이름 없이 안내만 있으면 근거가 아니다/);
  const deixisList = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.deixis].fewShotList;
  assert.ok(findContrastPair({ exampleList: deixisList, type: 'adjective_noun', isNamed: (after) => /고무나무 말이에요/.test(after) }), '한국어 이름 짝');
  assert.ok(findContrastPair({ exampleList: deixisList, type: 'adjective_noun', isNamed: (after) => /Bexa's the one/.test(after) }), '영어 이름 짝');
  assert.equal(deixisPrompt.includes('write B'), false);
});

// 여럿 가운데 하나만 결과가 달랐다고 짚은 뒤의 지시를, "만·only" 가 없다는 이유로 O 로 넘기는 오탐을 줄인다.
test('지시 대상은 "만·only" 가 없어도 하나만 결과가 달랐다고 짚었으면 그 하나로 본다', () => {
  const deixisPrompt = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.deixis].systemPrompt;
  assert.match(deixisPrompt, /"만·뿐·only"가 없어도 여럿 중 하나만 결과·상태가 달랐다고 말했으면/);
  assert.match(deixisPrompt, /여럿을 나란히 말하기만 했으면 O 다/);
  const deixisList = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.deixis].fewShotList;
  const resultExample = deixisList.find((example) => example.input.candidateList[0].type === 'demonstrative'
    && example.output.judgeList[0].gap === 'X' && !/만|뿐|only/i.test(example.input.before) && /2호기/.test(example.input.before));
  assert.ok(resultExample, '만·only 없이 결과로 하나를 짚은 X 예시');
});

// 앞에서 항목을 여럿 나열한 뒤 발표자가 하나를 골랐거나 뒤 발화가 항목 이름을 댄 수치를 O 로 넘기는 오탐을 줄인다.
// 세는 방법·출처만 말한 뒤 발화는 여전히 O 다(새 판단기가 옛 판단기보다 잘 잡던 누락을 지킨다).
test('단순 수치는 발표자가 고른 항목이나 뒤 발화가 댄 항목 이름으로 X 를 주고, 세는 방법만 말하면 O 다', () => {
  const speechPrompt = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.speech].systemPrompt;
  assert.match(speechPrompt, /앞에서도 뒤에서도 그중 어느 것의 값인지 말하지 않았으면 O 다/);
  assert.match(speechPrompt, /발표자가 지금 다룰 항목 하나를 이름으로 골랐다/);
  assert.match(speechPrompt, /뒤 발화가 다른 말 뒤에라도 그 수치가 어느 항목의 값인지 이름을 댔다/);
  assert.match(speechPrompt, /어떻게 셌는지·어디서 뽑았는지·어느 범위의 값인지만 말하면 어느 항목인지 정해지지 않았다 → O/);
  assert.match(speechPrompt, /항목 이름을 댄 구절도 근거다/);
  assert.match(speechPrompt, /앞뒤 발화가 항목을 정하지 않았다면 값이 적힌 곳\(화이트보드·메모장·칸\)만 말한 것도 O 다/);
  const speechList = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.speech].fewShotList;
  assert.ok(findContrastPair({ exampleList: speechList, type: 'number', isNamed: (after) => /와셔 쪽/.test(after) }), '뒤 발화 항목 이름 짝');
  assert.ok(speechList.some((example) => example.input.candidateList[0].type === 'number' && example.output.judgeList[0].gap === 'X'
    && /last meeting/.test(example.input.before) && example.input.before.includes(example.output.judgeList[0].evidence)
    && !/board asked/.test(example.input.before) && !/^Um\b/.test(example.input.utterance)), '지난 회의에서 정한 범위로 고른 항목 X 예시');
  const numberOList = speechList.filter((example) => example.input.candidateList[0].type === 'number' && example.output.judgeList[0].gap === 'O'
    && /와셔/.test(example.input.before));
  assert.equal(numberOList.length, 1);
  assert.equal(numberOList[0].input.after.includes(','), false, '세는 방법만 말하는 뒤 발화는 한 절이다');
});

// 척도 유형 이름의 "추상적"을 "추상적인 대상이면 O"로 읽어, 생각·가능성·기간처럼 사진에 찍히지 않는 주어에도 O 를 주는 오탐을 줄인다.
test('추상적 척도는 주어가 눈으로 볼 수 있는 것인지 먼저 보고, "추상적 표현"을 O 의 이유로 쓰지 않는다', () => {
  const speechPrompt = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.speech].systemPrompt;
  assert.match(speechPrompt, /먼저 "크다·많다·짧다"의 주어\(무엇이 큰가·많은가\)를 찾는다/);
  assert.match(speechPrompt, /사진에 찍히지 않는 것도 같다/);
  assert.match(speechPrompt, /"추상적인 표현이라 수치가 없다"는 O 의 이유가 아니다/);
  assert.match(speechPrompt, /앞 문맥 앞쪽에 나온 숫자도 그 대상의 값이면 된다/);
  const scaleXList = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.speech].fewShotList
    .filter((example) => example.input.candidateList[0].type === 'scale' && example.output.judgeList[0].gap === 'X');
  assert.ok(scaleXList.some((example) => /호응/.test(example.input.utterance)), '생각·감정 주어 X 예시');
  assert.ok(scaleXList.some((example) => /deadlines/.test(example.input.utterance)), '영어 기간 주어 X 예시');
});

// 범위·폭·다양성은 낱말이 아니라 그 범위를 가진 것이 눈에 보이는지로 가린다. 생각·선택·권한의 폭은 X, 사진·지도에 보이는 것이 퍼진 넓이는 O 가 될 수 있다.
test('추상적 척도의 범위·폭·다양성은 그 범위를 가진 것이 눈에 보이는지로 가린다', () => {
  const speechPrompt = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.speech].systemPrompt;
  assert.match(speechPrompt, /범위·폭·다양성은 그 범위를 가진 것이 눈에 보이는지로 가린다/);
  assert.match(speechPrompt, /생각·선택·권한처럼 보이지 않으면 X/);
  assert.match(speechPrompt, /사진·지도에 보이는 것이 퍼진 넓이면 O 가 될 수 있다/);
  for (const phrase of ['선호·의견·이론', '대상이 퍼진 범위', '보이는 대상이다(O)']) assert.equal(speechPrompt.includes(phrase), false, phrase);
});

// 같은 앞 문맥·뒤 문맥에서 트리거 문장의 대상만 다른 변화 예시 쌍. 앞 문맥에 값이 있는 대상이면 X, 이름만 있고 값이 없는 대상이면 O 다.
function findSubjectContrastPair(exampleList) {
  const changeList = exampleList.filter((example) => example.input.candidateList[0].type === 'change');
  return changeList.find((left) => changeList.some((right) => right !== left
    && right.input.before === left.input.before && right.input.after === left.input.after
    && right.input.utterance !== left.input.utterance
    && left.output.judgeList[0].gap === 'X' && right.output.judgeList[0].gap === 'O'
    && right.input.utterance.split(' ')[0] !== left.input.utterance.split(' ')[0]
    && left.input.before.includes(right.input.utterance.split(' ')[0])));
}

test('변화·비교·결론은 그 대상의 앞뒤 값이 앞 문맥에 이미 있으면 X, 다른 대상 값이거나 한쪽뿐이면 O 다', () => {
  const speechPrompt = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.speech].systemPrompt;
  assert.match(speechPrompt, /바뀌기 전·후 값\(비교면 양쪽 값\)이 앞 문맥에 이미 나왔으면 트리거 문장이 값을 다시 말하지 않아도 X 다/);
  assert.match(speechPrompt, /값이 다른 대상의 것이거나 한쪽만 있으면 O 다/);
  const changeExample = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.speech].fewShotList.find((example) => example.input.candidateList[0].type === 'change'
    && example.output.judgeList[0].gap === 'X' && !example.input.after.match(/\d/) && /\d/.test(example.input.before));
  assert.ok(changeExample, '앞 문맥 값으로 X 를 주는 변화 예시');
  const pairLeft = findSubjectContrastPair(ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.speech].fewShotList);
  assert.ok(pairLeft, '트리거 대상만 다른 X/O 변화 예시 짝');
  assert.ok(pairLeft.input.before.includes(pairLeft.input.utterance.split(' ')[0]), 'X 예시의 트리거 대상 낱말이 앞 문맥 이름과 같다');
  assert.match(pairLeft.input.before, /아직 정리 전/, 'O 짝 대상은 값이 없다는 뜻만 남긴다');
  assert.doesNotMatch(pairLeft.input.before, /다음 주에 끝나요/);
});

// 근거를 옮길 때 순서를 바꾸거나 두 곳을 합쳐 써서 코드 확인(not_in_context)에 걸려 O 로 뒤집히는 일을 줄인다.
test('근거는 순서·낱말을 바꾸지 않고 옮기고, 떨어진 두 곳은 "…"로 잇게 한다', () => {
  for (const group of Object.values(JUDGE_GROUP_MAP)) {
    const prompt = ROUTER_PROMPT_MAP[group].systemPrompt;
    assert.match(prompt, /순서·낱말을 바꾸지 않고 그대로 옮긴다/, group);
    assert.match(prompt, /각 구절을 그대로 옮겨 "…"로 잇는다/, group);
  }
});

// QA 2-19: 앞에 후보가 여럿이면 뒤 발화가 대상을 밝혀도 O 로 넘기고, "가리킨다고 명시하지 않았다"며 O 를 주던 오탐을 줄인다.
test('지시 대상 지시문은 뒤 발화·하나에만 붙은 말·짝지은 값으로 대상이 정해지면 X 로 보고, 확인 과잉으로 O 를 주지 않게 한다', () => {
  const deixisPrompt = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.deixis].systemPrompt;
  const speechPrompt = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.speech].systemPrompt;
  assert.match(deixisPrompt, /뒤 발화가 대상을 밝히면 앞에 후보가 여럿이었어도 X 다/);
  assert.match(deixisPrompt, /\*\*하나에만\*\* 붙은 말/);
  assert.match(deixisPrompt, /값을 비교해 고를 수 있으므로 X 다/);
  assert.match(deixisPrompt, /명시하지 않았다/);
  for (const rule of ['뒤 발화가 대상을 밝히면', '하나에만']) assert.equal(speechPrompt.includes(rule), false, rule);
  const deixisList = ROUTER_PROMPT_MAP[JUDGE_GROUP_MAP.deixis].fewShotList;
  assert.ok(deixisList.some((example) => /주말 오후 시간대요/.test(example.input.after)), '뒤 발화가 밝히는 X 짝 예시');
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

const config = {};
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
