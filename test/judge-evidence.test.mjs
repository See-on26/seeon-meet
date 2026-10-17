import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyValueEvidence, hasQuantityExpression } = require('../src/main/caption-pipeline/router/judge-evidence.js');
const { parseJudgeText, ROUTER_PROMPT_MAP } = require('../src/main/caption-pipeline/router/unified-router.js');

const FEW_SHOT_LIST = [...ROUTER_PROMPT_MAP.deixis.fewShotList, ...ROUTER_PROMPT_MAP.speech.fewShotList];

const changeContext = {
  before: '설치 전후 석 달을 비교했습니다.',
  utterance: '반품 접수가 확 줄었어요.',
  after: '월 40건에서 12건이 됐거든요.',
};

test('변화 후보의 근거는 문맥에 그대로 있고 수량이 들어 있어야 통과한다', () => {
  assert.equal(verifyValueEvidence({ type: 'change', phrase: '확 줄었어요', evidence: '월 40건에서 12건이 됐거든요', context: changeContext }).isVerified, true);
  const nameOnly = verifyValueEvidence({
    type: 'change', phrase: '더 빨랐어요', evidence: 'A팀과 B팀을 비교했습니다',
    context: { before: 'A팀과 B팀을 비교했습니다.', utterance: 'B팀이 더 빨랐어요.', after: '' },
  });
  assert.equal(nameOnly.isVerified, false);
  assert.equal(nameOnly.failReason, 'no_quantity');
});

test('근거가 비었거나 문맥에 없거나 후보 구 안에만 있으면 통과하지 못한다', () => {
  assert.equal(verifyValueEvidence({ type: 'change', phrase: '확 줄었어요', evidence: '', context: changeContext }).failReason, 'empty');
  assert.equal(verifyValueEvidence({ type: 'change', phrase: '확 줄었어요', evidence: '월 50건에서 10건', context: changeContext }).failReason, 'not_in_context');
  assert.equal(verifyValueEvidence({
    type: 'change', phrase: '30% 늘었어요', evidence: '30% 늘었어요',
    context: { before: '', utterance: '매출이 30% 늘었어요.', after: '' },
  }).failReason, 'phrase_only');
});

test('말줄임표로 이어 붙인 근거는 조각마다 문맥에 있으면 통과하고, 한 조각이라도 없으면 실패한다', () => {
  const context = {
    before: 'Before the retrofit, the plant used about 2.1 million kilowatt-hours a month. Since then, monthly use has been running at about 1.6 million.',
    utterance: 'So usage dropped a lot.',
    after: '',
  };
  const spliced = verifyValueEvidence({
    type: 'change', phrase: 'dropped a lot',
    evidence: 'the plant used about 2.1 million kilowatt-hours a month... monthly use has been running at about 1.6 million', context,
  });
  assert.equal(spliced.isVerified, true);
  const unicodeEllipsis = verifyValueEvidence({ type: 'change', phrase: 'dropped a lot', evidence: 'about 2.1 million … about 1.6 million', context });
  assert.equal(unicodeEllipsis.isVerified, true);
  const invented = verifyValueEvidence({ type: 'change', phrase: 'dropped a lot', evidence: 'about 2.1 million... about 0.9 million', context });
  assert.equal(invented.failReason, 'not_in_context');
});

test('근거 비교는 띄어쓰기·따옴표 차이를 무시한다', () => {
  const result = verifyValueEvidence({ type: 'change', phrase: '확 줄었어요', evidence: '"월 40건에서  12건이 됐거든요"', context: changeContext });
  assert.equal(result.isVerified, true);
});

test('수치 후보의 근거는 그 수치가 무엇인지 밝힌 말이어야 한다(숫자만 옮기면 안 된다)', () => {
  const context = { before: '', utterance: '올해 신규 가입자는 3,400명입니다.', after: '목표는 넘겼습니다.' };
  assert.equal(verifyValueEvidence({ type: 'number', phrase: '3,400명', evidence: '올해 신규 가입자는', context }).isVerified, true);
  assert.equal(verifyValueEvidence({ type: 'number', phrase: '3,400명', evidence: '3,400명', context }).failReason, 'phrase_only');
});

test('형용사 + 지시 명사의 근거는 문맥에 그대로 있어야 하고 후보 구만 옮기면 안 된다', () => {
  const context = { before: '두 업체 견적을 받았는데요, 동양물산은 840만 원, 한빛은 1,020만 원입니다.', utterance: '저는 싼 쪽으로 가고 싶어요.', after: '' };
  assert.equal(verifyValueEvidence({ type: 'adjective_noun', phrase: '싼 쪽', evidence: '동양물산은 840만 원, 한빛은 1,020만 원입니다', context }).isVerified, true);
  assert.equal(verifyValueEvidence({ type: 'adjective_noun', phrase: '싼 쪽', evidence: '싼 쪽', context }).failReason, 'phrase_only');
  assert.equal(verifyValueEvidence({ type: 'adjective_noun', phrase: '싼 쪽', evidence: '', context }).failReason, 'empty');
});

test('수량 표현은 숫자·한글 수사+단위·배수·영어 수 낱말을 알아본다', () => {
  for (const text of ['40건', '두 배로', '절반이 됐어요', '세 명', '삼십 퍼센트', 'doubled', 'went from five to nine', 'half of them']) {
    assert.equal(hasQuantityExpression(text), true, text);
  }
  for (const text of ['이번 달', 'A팀과 B팀을 비교했습니다', 'the new version', '한 번 보시죠']) {
    assert.equal(hasQuantityExpression(text), false, text);
  }
});

test('문맥을 받으면 수치·변화 X 판단 중 근거 확인에 실패한 것만 O 로 바꾼다', () => {
  const candidateList = [
    { id: 1, type: 'change', phrase: '확 줄었어요' },
    { id: 2, type: 'demonstrative', phrase: '이 부분' },
  ];
  const verifiedText = '{"judgeList":[{"id":1,"gap":"X","evidence":"월 40건에서 12건이 됐거든요","reason":"뒤에서 값을 밝혔다"},{"id":2,"gap":"X","evidence":"","reason":"앞 발화를 가리킨다"}]}';
  const verified = parseJudgeText({ text: verifiedText, candidateList, context: changeContext });
  assert.deepEqual(verified.map((entry) => entry.isGap), [false, false]);
  assert.equal(verified[0].evidence, '월 40건에서 12건이 됐거든요');

  const failedText = '{"judgeList":[{"id":1,"gap":"X","evidence":"반품 접수가 확 줄었어요","reason":"앞에서 비교 대상을 밝혔다"},{"id":2,"gap":"X","reason":"앞 발화를 가리킨다"}]}';
  const failed = parseJudgeText({ text: failedText, candidateList, context: changeContext });
  assert.deepEqual(failed.map((entry) => entry.isGap), [true, false]);
  assert.match(failed[0].reason, /^근거 확인 실패\(no_quantity\) → O · 원래 판단: 앞에서 비교 대상을 밝혔다/);
});

test('형용사 + 지시 명사의 X 판단도 근거가 없으면 O 로 본다', () => {
  const context = { before: '배너를 두 장 뽑았어요.', utterance: '회색 쪽이 더 눈에 띄네요.', after: '' };
  const judgeList = parseJudgeText({
    text: '{"judgeList":[{"id":1,"gap":"X","evidence":"","reason":"두 배너 중 회색인 것을 가리킨다"}]}',
    candidateList: [{ id: 1, type: 'adjective_noun', phrase: '회색 쪽' }],
    context,
  });
  assert.equal(judgeList[0].isGap, true);
});

test('문맥 없이 읽으면 예전처럼 판단을 그대로 쓴다', () => {
  const judgeList = parseJudgeText({
    text: '{"judgeList":[{"id":1,"gap":"X","reason":"앞에서 밝혔다"}]}',
    candidateList: [{ id: 1, type: 'number', phrase: '30%' }],
  });
  assert.equal(judgeList[0].isGap, false);
});

test('판단 지시문은 수치·변화의 근거 인용을 요구하고 few-shot 답은 모두 evidence 칸을 가진다', () => {
  for (const { systemPrompt } of Object.values(ROUTER_PROMPT_MAP)) assert.match(systemPrompt, /"evidence"/);
  assert.match(ROUTER_PROMPT_MAP.speech.systemPrompt, /비교 대상의 이름만 있으면 근거가 아니다/);
  assert.match(ROUTER_PROMPT_MAP.deixis.systemPrompt, /어느 것이 그런지 말하지 않으면 근거가 아니다/);
  for (const example of FEW_SHOT_LIST) {
    for (const entry of example.output.judgeList) assert.equal(typeof entry.evidence, 'string');
  }
  const verifiedExampleList = FEW_SHOT_LIST.flatMap((example) => example.output.judgeList
    .filter((entry) => entry.gap === 'X')
    .map((entry) => ({ entry, candidate: example.input.candidateList.find((candidate) => candidate.id === entry.id), example })))
    .filter(({ candidate }) => ['number', 'change', 'adjective_noun'].includes(candidate.type));
  assert.ok(verifiedExampleList.length >= 3);
  assert.ok(verifiedExampleList.some(({ candidate }) => candidate.type === 'adjective_noun'));
  for (const { entry, candidate, example } of verifiedExampleList) {
    const result = verifyValueEvidence({
      type: candidate.type, phrase: candidate.phrase, evidence: entry.evidence,
      context: { before: example.input.before, utterance: example.input.utterance, after: example.input.after },
    });
    assert.equal(result.isVerified, true, `${candidate.phrase}: ${result.failReason}`);
  }
});
