import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createProductionTrigger, extractProductionCandidateList, detectPieceCandidateList, RULE_PRODUCTION_TRIGGER, KOREAN_TRIGGER_ANALYZER_MAP,
} from '../tools/eval/lib/production-trigger.mjs';

const require = createRequire(import.meta.url);
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');

// production 과 같은 Kiwi 모델(npm run setup:kiwi)이 있어야 품사 규칙 결과를 잰다. 없으면 그 시험만 건너뛴다.
const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
let kiwiTrigger = null;

before(async () => {
  if (hasKiwiModel) kiwiTrigger = await createProductionTrigger();
});

const spanList = (candidateList) => candidateList.map(({ type, triggerType, trigger, start, end, utteranceIndex }) => [
  type, triggerType, trigger, start, end, utteranceIndex,
]);

test('production 트리거 유형을 평가 유형으로 옮기고 위치는 전사 원문 기준이다(단순 수치 number → value)', () => {
  const item = { id: 'x', transcript: '여러분, 이 사진을 보시죠. [무발화 7초] 보시는 것처럼 30%예요.' };
  assert.deepEqual(spanList(extractProductionCandidateList({ item, productionTrigger: RULE_PRODUCTION_TRIGGER })), [
    ['demonstrative', 'demonstrative', '이 사진', 5, 9, 0],
    ['value', 'number', '30%', 33, 36, 2],
  ], '무발화 표시 안의 "7초" 는 발화가 아니라 보지 않는다');
});

test('같은 표현이 한 발화에 두 번 나오면 둘 다 후보다(production 은 조각의 후보를 모두 판단 LLM 에 넘긴다)', () => {
  const item = { id: 'x', transcript: '이 부분을 보시면 그리고 이 부분도 보시면 됩니다.' };
  assert.deepEqual(spanList(extractProductionCandidateList({ item, productionTrigger: RULE_PRODUCTION_TRIGGER })), [
    ['demonstrative', 'demonstrative', '이 부분', 0, 4, 0],
    ['demonstrative', 'demonstrative', '이 부분', 14, 18, 0],
  ]);
});

test('영어 발화는 production 영어 규칙으로 지시·수치·변화를 잡는다', () => {
  const item = { id: 'x', language: 'en', transcript: 'Okay, moving on. This part is 30% of errors.' };
  assert.deepEqual(spanList(extractProductionCandidateList({ item, productionTrigger: RULE_PRODUCTION_TRIGGER })), [
    ['demonstrative', 'demonstrative', 'This part', 17, 26, 1],
    ['value', 'number', '30%', 30, 33, 1],
  ]);
});

test('판단 LLM 에 넘길 위치(pieceStart·pieceEnd)는 발화 글 기준이고 앞 공백을 뗀 만큼 옮긴다', () => {
  const piece = { index: 3, start: 40, text: '  이 부분에서 오류가 납니다.' };
  const [candidate] = detectPieceCandidateList({ piece, productionTrigger: RULE_PRODUCTION_TRIGGER });
  assert.deepEqual(
    [candidate.phrase, candidate.pieceStart, candidate.pieceEnd, candidate.start, candidate.end, candidate.utteranceIndex],
    ['이 부분', 2, 6, 42, 46, 3],
  );
  assert.equal(piece.text.slice(candidate.pieceStart, candidate.pieceEnd), '이 부분');
});

test('Kiwi 를 띄우지 못하면 production 처럼 경고하고 한국어는 대체 규칙으로 잡는다', async () => {
  const warnList = [];
  const failing = await createProductionTrigger({
    createTokenizer: () => ({ load: async () => { throw new Error('모델 없음'); }, isReady: () => false, tokenize: () => null }),
    onWarn: (message) => warnList.push(message),
  });
  assert.equal(failing.koreanAnalyzer, KOREAN_TRIGGER_ANALYZER_MAP.rule);
  assert.match(warnList.join('\n'), /대체 규칙.*모델 없음/);
  assert.equal(failing.detect({ text: '이 부분에서 30%가 늘었습니다.' }).analyzer, 'rule');

  const ready = await createProductionTrigger({
    createTokenizer: () => ({ load: async () => ({ elapsedMs: 1 }), isReady: () => true, tokenize: () => [] }),
    onWarn: (message) => warnList.push(message),
  });
  assert.equal(ready.koreanAnalyzer, KOREAN_TRIGGER_ANALYZER_MAP.kiwi);
  assert.equal(warnList.length, 1);
});

test('Kiwi 모델이 있으면 production 과 같은 품사 규칙으로 잡는다', { skip: !hasKiwiModel }, () => {
  assert.equal(kiwiTrigger.koreanAnalyzer, KOREAN_TRIGGER_ANALYZER_MAP.kiwi);
  const detect = (transcript) => spanList(extractProductionCandidateList({ item: { id: 'x', transcript }, productionTrigger: kiwiTrigger }));
  assert.deepEqual(detect('두 안 중에 싼 쪽으로 가죠.'), [['adjective_noun', 'adjective_noun', '싼 쪽', 7, 10, 0]]);
  assert.deepEqual(detect('저기요, 잠깐만요. 저기 보이는 숫자가 중요합니다.'), [['demonstrative', 'demonstrative', '저기', 11, 13, 1]],
    '감탄사 "저기요" 는 잡지 않는다');
  assert.deepEqual(detect('음, 대기 시간이 꽤 길죠. 평균 40분인데 업계 평균은 10분이거든요.'), [
    ['scale', 'scale', '꽤 길죠', 10, 14, 0],
    ['value', 'number', '40분', 19, 22, 1],
    ['value', 'number', '10분', 32, 35, 1],
  ]);
});
