import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutsideKey, toOutsideVerdictList, scoreOutsideVerdictList, parseArgs } from '../tools/detection-eval/run-detection-eval.mjs';

test('정답 밖 위치 키는 문항 id 와 트리거 문장 안 위치로 만든다', () => {
  assert.equal(buildOutsideKey({ id: 'abc', start: 3, end: 9 }), 'abc@3-9');
});

test('판단 목록에서 정답 후보를 뺀 나머지를 정답 밖 판단으로 모은다', () => {
  const outsideList = toOutsideVerdictList({
    id: 'abc',
    judgeList: [
      { phrase: '이 부분', start: 0, end: 4, isGap: true },
      { phrase: '줄이겠습니다', start: 10, end: 16, isGap: true },
      { phrase: '두 대', start: 20, end: 23, isGap: false },
    ],
    matchedInSentence: { start: 0, end: 4 },
  });
  assert.deepEqual(outsideList, [
    { key: 'abc@10-16', phrase: '줄이겠습니다', isPredictedGap: true },
    { key: 'abc@20-23', phrase: '두 대', isPredictedGap: false },
  ]);
});

test('라벨이 있는 정답 밖 판단만 혼동표에 더하고, 라벨 없는 위치는 따로 센다', () => {
  const labelMap = new Map([['a@0-2', 'X'], ['b@0-2', 'O'], ['c@0-2', 'X']]);
  const score = scoreOutsideVerdictList({
    outsideVerdictList: [
      { key: 'a@0-2', isPredictedGap: true },
      { key: 'b@0-2', isPredictedGap: true },
      { key: 'c@0-2', isPredictedGap: false },
      { key: 'd@0-2', isPredictedGap: true },
    ],
    labelMap,
  });
  assert.deepEqual(score, { tp: 1, fp: 1, fn: 0, tn: 1, unlabeledCount: 1 });
});

test('--outside-labels 인자를 읽는다', () => {
  const option = parseArgs(['--db', '/db', '--split', 'val', '--judge', '--outside-labels', '/labels.json']);
  assert.equal(option.outsideLabels, '/labels.json');
});
