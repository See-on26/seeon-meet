import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseJudgeText, toNarrationCandidateList, buildRouterInput, ROUTER_PROMPT_MAP,
} = require('../src/main/caption-pipeline/router/unified-router.js');

const FEW_SHOT_LIST = [...ROUTER_PROMPT_MAP.deixis.fewShotList, ...ROUTER_PROMPT_MAP.speech.fewShotList];

const candidateList = [
  { id: 1, type: 'demonstrative', phrase: '이 부분' },
  { id: 2, type: 'number', phrase: '30%' },
  { id: 3, type: 'change', phrase: '많이 올랐습니다' },
  { id: 4, type: 'scale', phrase: '꽤 넓죠' },
  { id: 5, type: 'adjective_noun', phrase: '빨간 쪽' },
];

test('판단 JSON 을 후보 id 마다 읽고, 답이 없거나 O 가 아니면 X 로 본다', () => {
  const judgeList = parseJudgeText({
    text: '```json\n{"judgeList":[{"id":1,"gap":"O","reason":"없다"},{"id":2,"gap":"X","reason":"앞에서 밝혔다"},{"id":3,"gap":"o"}]}\n```',
    candidateList,
  });
  assert.deepEqual(judgeList.map((entry) => [entry.id, entry.isGap]), [[1, true], [2, false], [3, true], [4, false], [5, false]]);
  assert.equal(judgeList[1].reason, '앞에서 밝혔다');
  assert.equal(judgeList[3].reason, '판단 없음');
  assert.ok(parseJudgeText({ text: '모르겠다', candidateList }).every((entry) => !entry.isGap));
});

test('공백 후보를 유형에 맞는 에이전트 해설로 바꾼다(지시 2개 이상이면 완전형)', () => {
  const narrationList = toNarrationCandidateList(candidateList.map((candidate) => ({ ...candidate, isGap: true })));
  assert.deepEqual(narrationList.map((entry) => [entry.type, entry.subKind, entry.reference, entry.anchor]), [
    ['deixis', 'complete', 'explicit', '이 부분'],
    ['interpretation', 'value_to_meaning', null, '30%'],
    ['interpretation', 'claim_to_value', null, '많이 올랐습니다'],
    ['visual_description', 'scale', null, '꽤 넓죠'],
    ['deixis', 'complete', 'inclusive', '빨간 쪽'],
  ]);
  const single = toNarrationCandidateList([{ ...candidateList[0], isGap: true }, { ...candidateList[1], isGap: false }]);
  assert.deepEqual(single.map((entry) => [entry.type, entry.subKind]), [['deixis', 'simple']]);
});

test('판단 입력에 앞 문맥·트리거 문장·뒤 문맥·번호 붙인 후보를 적는다', () => {
  const input = buildRouterInput({ before: '앞', utterance: '이 부분이 30%예요', after: '뒤', candidateList: candidateList.slice(0, 2) });
  assert.match(input, /앞 문맥: 앞/);
  assert.match(input, /트리거 문장: "이 부분이 30%예요"/);
  assert.match(input, /뒤 문맥: 뒤/);
  assert.match(input, /1\) \[지시대명사\] "이 부분"\n2\) \[단순 수치\] "30%"/);
});

test('판단 지시문은 지시 대상 원칙·척도 주어 기준·최소 출력 원칙을 담는다', () => {
  assert.match(ROUTER_PROMPT_MAP.deixis.systemPrompt, /지시 표현이 앞뒤 발화에 언급된 것 \*\*하나\*\*와 이어지면, 그것의 이름·내용을 밝히지 않았어도 X/);
  assert.match(ROUTER_PROMPT_MAP.speech.systemPrompt, /수치가 앞뒤 발화에 언급된 것 \*\*하나\*\*와 이어지면, 그것의 이름·내용을 밝히지 않았어도 X/);
  assert.match(ROUTER_PROMPT_MAP.speech.systemPrompt, /화면으로 볼 수 없는 성질이 주어면 정도가 없어도 X/);
  for (const { systemPrompt } of Object.values(ROUTER_PROMPT_MAP)) assert.match(systemPrompt, /애매하면 내보내지 않는다/);
});

test('few-shot 답은 모두 후보 수만큼 O/X 를 낸다', () => {
  for (const example of FEW_SHOT_LIST) {
    assert.equal(example.output.judgeList.length, example.input.candidateList.length);
    assert.ok(example.output.judgeList.every((entry) => ['O', 'X'].includes(entry.gap)));
  }
});
