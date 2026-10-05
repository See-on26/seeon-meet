import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateDetectionItemList, validateQuestionSet, ISSUE_LEVEL_MAP } from '../tools/eval/lib/dataset-validate.mjs';
import { TARGET_TYPE_LIST } from '../tools/eval/lib/eval-types.mjs';

const readSample = (name) => fs.readFileSync(new URL(`../docs/eval/samples/${name}`, import.meta.url), 'utf8');
const errorList = (issueList) => issueList.filter((issue) => issue.level === ISSUE_LEVEL_MAP.error);

test('3.1 샘플은 회의록 예시 16건이고 유형 6개·두 언어·목표 정답이 모두 있다', () => {
  const { itemList, issueList } = validateDetectionItemList({ text: readSample('detection-items.sample.jsonl') });
  assert.deepEqual(errorList(issueList), []);
  assert.equal(itemList.length, 16);
  assert.deepEqual([...new Set(itemList.map((item) => item.targetType))].sort(), [...TARGET_TYPE_LIST].sort());
  assert.deepEqual(Object.fromEntries([...Map.groupBy(itemList, (item) => item.language)].map(([language, list]) => [language, list.length])), { ko: 14, en: 2 });
  assert.ok(itemList.every((item) => item.targetTrigger && typeof item.isTargetGap === 'boolean' && item.targetRationale));
  assert.equal(itemList.filter((item) => item.isTargetGap).length, 7);
  const pairMap = Map.groupBy(itemList, (item) => item.pairId);
  for (const pairId of ['p-01', 'p-02', 'p-03', 'p-04', 'p-05', 'p-06']) {
    assert.deepEqual(pairMap.get(pairId).map((item) => item.isTargetGap).sort(), [false, true], pairId);
  }
});

test('3.2 샘플 문항 셋은 형식 오류가 없다', () => {
  const { questionSet, issueList } = validateQuestionSet({ text: readSample('questions.sample.json') });
  assert.deepEqual(errorList(issueList), []);
  assert.ok(questionSet.questionList.length >= 3);
  assert.ok(questionSet.videoList[0].humanAdList.length >= 1);
});
