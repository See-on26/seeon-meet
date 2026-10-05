import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateDetectionItemList, validateQuestionSet, validateFile, findLineNumberOfId, ISSUE_LEVEL_MAP,
} from '../tools/eval/lib/dataset-validate.mjs';
import { listSilenceMarker } from '../tools/eval/lib/silence-marker.mjs';

const baseItem = {
  id: 'd-001', language: 'ko', domain: '발표', pairId: 'p-01', targetType: 'demonstrative', resolution: 'none',
  generatorModel: 'gpt-5', transcript: '자, 다음으로 넘어가 볼게요. 이 부분에서 오류가 제일 많이 납니다.',
};

const toJsonl = (itemList) => itemList.map((item) => JSON.stringify(item)).join('\n');
const errorList = (issueList) => issueList.filter((issue) => issue.level === ISSUE_LEVEL_MAP.error);

test('무발화 표시는 위치와 길이(ms)로 읽는다', () => {
  assert.deepEqual(listSilenceMarker('보시죠. [무발화 7초] 네.'), [
    { start: 5, end: 13, trigger: '[무발화 7초]', silenceMs: 7000 },
  ]);
  assert.equal(listSilenceMarker('[무발화 2.5초]')[0].silenceMs, 2500);
});

test('형식이 맞는 3.1 항목은 오류가 없다', () => {
  const { itemList, issueList } = validateDetectionItemList({ text: toJsonl([baseItem]) });
  assert.equal(itemList.length, 1);
  assert.deepEqual(errorList(issueList), []);
});

test('잘못된 칸을 줄 번호와 함께 알린다', () => {
  const text = [
    JSON.stringify(baseItem),
    JSON.stringify({ ...baseItem, id: 'd-002', targetType: 'color', language: 'ja', resolution: 'later' }),
    '{깨진 줄',
    JSON.stringify({ ...baseItem }),
  ].join('\n');
  const issueList = errorList(validateDetectionItemList({ text }).issueList);
  assert.deepEqual(issueList.map((issue) => [issue.lineNumber, issue.field]), [
    [2, 'targetType'], [2, 'language'], [2, 'resolution'], [3, '(줄 전체)'], [4, 'id'],
  ]);
});

test('무발화 유형은 5초 이상 표시가 있어야 한다', () => {
  const item = { ...baseItem, targetType: 'silence', transcript: '잠깐만요. [무발화 3초] 네.' };
  const issueList = errorList(validateDetectionItemList({ text: toJsonl([item]) }).issueList);
  assert.equal(issueList[0].field, 'transcript');
});

test('목표 트리거는 전사 안에 있어야 하고 정답은 true·false 다', () => {
  const item = { ...baseItem, targetTrigger: '저 부분', isTargetGap: 'O' };
  const fieldList = errorList(validateDetectionItemList({ text: toJsonl([item]) }).issueList).map((issue) => issue.field);
  assert.deepEqual(fieldList, ['targetTrigger', 'isTargetGap']);
});

test('utteranceList 는 전사 순서대로 찾을 수 있어야 하고 시각이 맞아야 한다', () => {
  const item = {
    ...baseItem,
    utteranceList: [
      { text: '이 부분에서 오류가 제일 많이 납니다.', startMs: 3000, endMs: 6000 },
      { text: '자, 다음으로 넘어가 볼게요.', startMs: 0, endMs: 2000 },
    ],
  };
  const fieldList = errorList(validateDetectionItemList({ text: toJsonl([item]) }).issueList).map((issue) => issue.field);
  assert.deepEqual(fieldList, ['utteranceList[1]', 'utteranceList[1]']);
});

test('라벨 위치는 전사 글자와 같아야 하고 isGap 은 true·false·null 이다', () => {
  const item = {
    ...baseItem,
    positionList: [
      { posId: 'demonstrative@17-21', type: 'demonstrative', start: 17, end: 21, trigger: '이 부분', sourceList: ['production'], isGap: true, rationale: '' },
      { posId: 'x', type: 'demonstrative', start: 17, end: 21, trigger: '그 부분', sourceList: ['manual'], isGap: 'O' },
    ],
  };
  const fieldList = errorList(validateDetectionItemList({ text: toJsonl([item]) }).issueList).map((issue) => issue.field);
  assert.deepEqual(fieldList, ['positionList[1].trigger', 'positionList[1].sourceList', 'positionList[1].isGap']);
});

test('--labeled 로 검사하면 positionList 가 없는 줄을 오류로 본다', () => {
  const issueList = errorList(validateDetectionItemList({ text: toJsonl([baseItem]), isLabeledRequired: true }).issueList);
  assert.equal(issueList[0].field, 'positionList');
});

const baseQuestionSet = {
  generatorModel: 'gpt-5',
  videoList: [{ videoId: 'v1', domain: '발표', file: 'v1.mp4', humanAdList: [{ startMs: 12000, text: '막대그래프: 재구매율 30%' }] }],
  questionList: [{
    id: 'q1', videoId: 'v1', category: '조각', subcategory: '수치 의미 파악',
    question: '발표자가 말한 30%는 무엇의 수치인가?', choiceList: ['재구매율', '이탈률', '전환율', '응답률'], answerIndex: 0,
  }],
};

test('형식이 맞는 문항 셋은 오류가 없고 영상 언어는 ko·en 중 하나다', () => {
  const { issueList } = validateQuestionSet({ text: JSON.stringify(baseQuestionSet, null, 2) });
  assert.deepEqual(errorList(issueList), []);
  const wrongLanguage = { ...baseQuestionSet, videoList: [{ ...baseQuestionSet.videoList[0], language: 'jp' }] };
  assert.deepEqual(errorList(validateQuestionSet({ text: JSON.stringify(wrongLanguage) }).issueList).map((issue) => issue.field), ['videoList[0].language']);
});

test('문항 셋 오류는 그 문항 id 가 있는 줄을 알려 준다', () => {
  const questionSet = {
    ...baseQuestionSet,
    questionList: [
      ...baseQuestionSet.questionList,
      {
        id: 'q2', videoId: 'v9', category: '조각', subcategory: '교차 조회',
        question: '?', choiceList: ['가', '나', '다', '알 수 없음'], answerIndex: 4,
      },
    ],
  };
  const text = JSON.stringify(questionSet, null, 2);
  const issueList = errorList(validateQuestionSet({ text }).issueList);
  const expectedLine = findLineNumberOfId({ text, id: 'q2' });
  assert.ok(expectedLine > 1);
  assert.deepEqual(issueList.map((issue) => [issue.lineNumber, issue.field]), [
    [expectedLine, 'questionList[1].videoId'],
    [expectedLine, 'questionList[1].category'],
    [expectedLine, 'questionList[1].choiceList'],
    [expectedLine, 'questionList[1].answerIndex'],
  ]);
});

test('확장자로 종류를 고르고 CLI 는 오류가 있으면 1 로 끝난다', () => {
  assert.equal(validateFile({ filePath: 'a.jsonl', text: toJsonl([baseItem]) }).kind, 'detection');
  assert.equal(validateFile({ filePath: 'q.json', text: JSON.stringify(baseQuestionSet) }).kind, 'question');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-validate-'));
  const goodFile = path.join(dir, 'items.jsonl');
  const badFile = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(goodFile, toJsonl([baseItem]));
  fs.writeFileSync(badFile, toJsonl([{ ...baseItem, targetType: 'x' }]));
  const cliPath = new URL('../tools/eval/validate.mjs', import.meta.url).pathname;
  const good = spawnSync(process.execPath, [cliPath, goodFile], { encoding: 'utf8' });
  const bad = spawnSync(process.execPath, [cliPath, badFile], { encoding: 'utf8' });
  assert.equal(good.status, 0);
  assert.match(good.stdout, /형식 오류 없음/);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /1번째 줄 · targetType/);
});
