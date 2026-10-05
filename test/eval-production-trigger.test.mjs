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

test('(^|\\s) 로 시작하는 일치는 앞 낱말 속 같은 글자열이 아니라 실제 자리를 쓴다', () => {
  const differenceText = '숫자가 많이 차이가 나는데 이 차이가 중요합니다';
  assert.deepEqual(spanList(extractProductionCandidateList({ text: differenceText })), [
    ['change', 'data', '차이가', 7, 10],
    ['demonstrative', 'demonstrative', '이 차이가', 15, 20],
    ['change', 'data', '차이가', 17, 20],
  ]);
  assert.equal(detectProductionFiredTrigger({ text: differenceText }).start, 15);

  const fileText = '로그 파일을 보면 그 파일을 열어야 해요';
  const fileCandidateList = extractProductionCandidateList({ text: fileText });
  assert.deepEqual(
    spanList(fileCandidateList.filter(({ kind }) => kind === 'demonstrative')),
    [['demonstrative', 'demonstrative', '그 파일을', 10, 15]],
  );
  assert.deepEqual(spanList(fileCandidateList), [
    ['demonstrative', 'demonstrative', '그 파일을', 10, 15],
    ['demonstrative', 'pointing', '열', 16, 17],
  ], '"열어야"의 열은 production 가리킴 명사 글자열 오탐 그대로다');
  assert.deepEqual(detectProductionFiredTrigger({ text: fileText }), {
    kind: 'demonstrative', trigger: '그 파일을', type: 'demonstrative', start: 10, end: 15,
  });

  const directionText = '마감을 금요일로 옮기고 일로 오세요';
  assert.deepEqual(spanList(extractProductionCandidateList({ text: directionText })), [
    ['demonstrative', 'demonstrative', '일로', 13, 15],
  ]);
  assert.equal(detectProductionFiredTrigger({ text: directionText }).start, 13);
});

test('글자열 포함으로 잡는 트리거는 낱말 속 첫 자리도 그대로 후보다', () => {
  assert.deepEqual(spanList(extractProductionCandidateList({ text: '보여서 좋고 여서 가자' })), [
    ['demonstrative', 'demonstrative', '여서', 1, 3],
    ['demonstrative', 'demonstrative', '여서', 7, 9],
  ]);
});

test('첫 지시 관형사 뒤가 때·정도 같은 비지시 명사여도 뒤의 지시 관형사+명사를 뽑는다', () => {
  const nonReferentText = '그 때 이 사람이 왔고 저 사람이 갔다';
  assert.deepEqual(spanList(extractProductionCandidateList({ text: nonReferentText })), [
    ['demonstrative', 'demonstrative', '이 사람이', 4, 9],
    ['demonstrative', 'demonstrative', '저 사람이', 13, 18],
  ]);
  assert.deepEqual(spanList(extractProductionCandidateList({ text: '이 정도면 됩니다. 그 방식으로 가죠' })), [
    ['demonstrative', 'demonstrative', '그 방식으로', 11, 17],
  ]);
  assert.equal(detectProductionFiredTrigger({ text: nonReferentText }), null, '실제 발동은 production 첫 일치 그대로라 발동하지 않는다');
});

test('실제로 발동하는 1건은 제품의 활성 종류 기준이다', () => {
  assert.deepEqual(detectProductionFiredTrigger({ text: '음, 대기 시간이 꽤 길죠. 평균 40분인데 업계 평균은 10분이거든요.' }), {
    kind: 'demonstrative', trigger: '이거', type: 'demonstrative', start: 35, end: 37,
  });
  assert.equal(detectProductionFiredTrigger({ text: '잠시 판서하겠습니다.' }), null);
});
