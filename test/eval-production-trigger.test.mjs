import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProductionCandidateList, detectProductionFiredTrigger, classifyDataTrigger, MASK_CHAR,
} from '../tools/eval/lib/production-trigger.mjs';
import { detectDeixis } from '../src/renderer/core/trigger/deixis-detector.js';

const spanList = (candidateList) => candidateList.map(({ type, kind, trigger, start, end }) => [type, kind, trigger, start, end]);

test('가림 문자는 한글·영문·숫자·공백이 아니다', () => {
  assert.doesNotMatch(MASK_CHAR, /[가-힣A-Za-z0-9\s]/);
});

test('같은 트리거가 여러 번 나오면 가림 반복으로 모든 위치를 뽑는다', () => {
  const text = '이 부분을 보시면 그리고 이 부분도 보시면 됩니다.';
  assert.deepEqual(spanList(extractProductionCandidateList({ text })), [
    ['demonstrative', 'demonstrative', '이 부분', 0, 4],
    ['demonstrative', 'pointing', '부분', 2, 4],
    ['demonstrative', 'demonstrative', '이 부분', 14, 18],
    ['demonstrative', 'pointing', '부분', 16, 18],
  ]);
  assert.deepEqual(detectDeixis(text), { isDeixis: true, trigger: '이 부분', kind: 'demonstrative' }, 'production 은 첫 1건만 준다');
});

test('data 트리거는 숫자·% 면 3-1, 변화·통계 단서면 3-2 다', () => {
  assert.equal(classifyDataTrigger('30%'), 'value');
  assert.equal(classifyDataTrigger('3 명'), 'value');
  assert.equal(classifyDataTrigger('십 명'), 'value');
  assert.equal(classifyDataTrigger('올랐'), 'change');
  assert.equal(classifyDataTrigger('평균'), 'change');
  assert.deepEqual(spanList(extractProductionCandidateList({ text: '보시는 것처럼 30%예요. 생각보다 높죠?' })), [
    ['value', 'data', '30%', 8, 11],
  ]);
  assert.deepEqual(spanList(extractProductionCandidateList({ text: '작년이랑 비교해 보면 많이 올랐습니다.' })), [
    ['change', 'data', '올랐', 15, 17],
  ]);
});

test('production 색 트리거는 2-2(형용사+지시 명사)로 보고 그 밖의 형용사는 잡지 못한다', () => {
  assert.deepEqual(spanList(extractProductionCandidateList({ text: '그래프에 선이 두 개 있는데요. 빨간 쪽이 저희 회사입니다.' })), [
    ['adjective_noun', 'color', '빨간 쪽', 18, 22],
  ]);
  assert.deepEqual(extractProductionCandidateList({ text: '두 안 중에 싼 쪽으로 가죠.' }), []);
  assert.deepEqual(spanList(extractProductionCandidateList({ text: 'Okay, moving on. This part is where most errors happen. It was 30%.' })), [
    ['value', 'data', '30%', 63, 66],
  ], '영어는 숫자+% 만 잡는다');
});

test('글자열 오탐도 production 그대로 후보가 된다', () => {
  assert.deepEqual(spanList(extractProductionCandidateList({ text: '저기요 보여서 좋네요 이점이 큽니다' })), [
    ['demonstrative', 'demonstrative', '저기', 0, 2],
    ['demonstrative', 'demonstrative', '여서', 5, 7],
    ['demonstrative', 'demonstrative', '이점', 12, 14],
  ]);
});

test('추상적 척도는 production 트리거가 없다', () => {
  assert.deepEqual(extractProductionCandidateList({ text: '음, 대기 시간이 꽤 길죠. 그래서 개선이 필요합니다.' }), []);
});

test('실제로 발동하는 1건은 제품의 활성 종류 기준이다', () => {
  assert.deepEqual(detectProductionFiredTrigger({ text: '음, 대기 시간이 꽤 길죠. 평균 40분인데 업계 평균은 10분이거든요.' }), {
    kind: 'demonstrative', trigger: '이거', type: 'demonstrative', start: 35, end: 37,
  });
  assert.equal(detectProductionFiredTrigger({ text: '잠시 판서하겠습니다.' }), null);
});
