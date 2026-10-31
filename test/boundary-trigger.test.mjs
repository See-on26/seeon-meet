import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSpeechTrigger } = require('../src/main/caption-pipeline/trigger/speech-trigger.js');
const { createKiwiTokenizer } = require('../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');
const { createBoundaryTrigger, BOUNDARY_MAX_GAP_MS } = require('../src/main/caption-pipeline/trigger/boundary-trigger.js');

// ASR 은 3초에서 조각을 강제로 자른다. 동사 줄기와 어미 사이("크게 늘 | 었습니다")에서 갈리면
// 조각마다 돌리는 트리거는 양쪽 다 후보를 못 뽑아 "특히 장비가 크게 늘었습니다" 해설이 통째로 빠졌다.
const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
let kiwiTrigger = null;

before(async () => {
  if (!hasKiwiModel) return;
  const tokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await tokenizer.load();
  kiwiTrigger = createSpeechTrigger({ tokenizer });
});

const phraseListOf = (result) => result.candidateList.map((candidate) => [candidate.type, candidate.phrase]);

test('어절 안에서 갈린 변화 표현을 뒷조각의 경계 후보로 붙인다', { skip: !hasKiwiModel }, () => {
  const boundary = createBoundaryTrigger({ detect: kiwiTrigger.detect });
  const first = boundary.detect({ text: '시범 구간과 장비가 해마다 크게 늘', startTs: 0, endTs: 3000 });
  assert.deepEqual(phraseListOf(first), []);
  const second = boundary.detect({ text: '었습니다. 다른 지역도 차례대로 준비하고 있습니다.', startTs: 3000, endTs: 6000 });
  assert.deepEqual(phraseListOf(second), [['change', '크게 늘']]);
  assert.equal(second.candidateList[0].isBoundary, true);
  assert.equal(second.candidateList[0].start, 0);
  assert.equal(second.boundaryCount, 1);
});

test('어절 사이에서 갈려 뒷조각이 스스로 잡은 후보는 경계 후보로 또 붙이지 않는다', { skip: !hasKiwiModel }, () => {
  const boundary = createBoundaryTrigger({ detect: kiwiTrigger.detect });
  boundary.detect({ text: '특히 장비가 크게', startTs: 0, endTs: 3000 });
  const second = boundary.detect({ text: '늘었습니다.', startTs: 3000, endTs: 4500 });
  assert.equal(second.boundaryCount, 0);
  assert.deepEqual(phraseListOf(second), [['change', '늘었습니다']]);
});

function createFakeDetect(candidateByTextMap) {
  const callList = [];
  const detect = ({ text }) => {
    callList.push(text);
    return { language: 'ko', analyzer: 'kiwi', candidateList: candidateByTextMap[text] || [] };
  };
  return { detect, callList };
}

test('앞 조각이 문장을 끝냈으면 이어 붙여 보지 않는다', () => {
  const { detect, callList } = createFakeDetect({});
  const boundary = createBoundaryTrigger({ detect });
  boundary.detect({ text: '정리했습니다.', startTs: 0, endTs: 3000 });
  boundary.detect({ text: '다음 장입니다', startTs: 3000, endTs: 6000 });
  assert.deepEqual(callList, ['정리했습니다.', '다음 장입니다']);
});

test('앞 조각과 시간이 떨어져 있거나 순서가 뒤바뀌어 오면 이어 붙여 보지 않는다', () => {
  const { detect, callList } = createFakeDetect({});
  const boundary = createBoundaryTrigger({ detect });
  boundary.detect({ text: '장비가 크게 늘', startTs: 0, endTs: 3000 });
  boundary.detect({ text: '었습니다', startTs: 3000 + BOUNDARY_MAX_GAP_MS + 1, endTs: 9000 });
  boundary.detect({ text: '앞 조각', startTs: 1000, endTs: 2500 });
  assert.deepEqual(callList, ['장비가 크게 늘', '었습니다', '앞 조각']);
});

test('앞 꼬리에서 시작해 앞 조각이 이미 잡은 후보와 이 조각 안의 후보는 경계 후보로 붙이지 않는다', () => {
  const tail = '여기 크게 늘';
  const joined = `${tail} 었습니다 이 표`;
  const { detect } = createFakeDetect({
    [tail]: [{ type: 'demonstrative', phrase: '여기', start: 0, end: 2 }],
    '었습니다 이 표': [{ type: 'demonstrative', phrase: '이 표', start: 5, end: 8 }],
    [joined]: [
      { type: 'demonstrative', phrase: '여기', start: 0, end: 2 },
      { type: 'change', phrase: '크게 늘', start: 3, end: 7 },
      { type: 'demonstrative', phrase: '이 표', start: 13, end: 16 },
    ],
  });
  const boundary = createBoundaryTrigger({ detect });
  boundary.detect({ text: tail, startTs: 0, endTs: 3000 });
  const second = boundary.detect({ text: '었습니다 이 표', startTs: 3000, endTs: 6000 });
  assert.deepEqual(phraseListOf(second), [['change', '크게 늘'], ['demonstrative', '이 표']]);
  assert.equal(second.boundaryCount, 1);
});

test('reset 하면 앞 조각을 잊는다(캡처 세션 시작)', () => {
  const { detect, callList } = createFakeDetect({});
  const boundary = createBoundaryTrigger({ detect });
  boundary.detect({ text: '장비가 크게 늘', startTs: 0, endTs: 3000 });
  boundary.reset();
  boundary.detect({ text: '었습니다', startTs: 3000, endTs: 6000 });
  assert.deepEqual(callList, ['장비가 크게 늘', '었습니다']);
});

// 실험실 기록 1,709조각을 다시 돌려 보니, 앞 꼬리를 몇 어절로 자르면서 짧아진 구("크게 늘었습니다" → "늘었습니다")나
// 앞 조각이 이미 다른 유형으로 잡은 구("더 높" → "높 는 겁")가 경계 후보로 또 붙었다. 경계에 닿는 새 구만 붙인다.
test('앞 조각 안에서 끝난 구는 꼬리를 자르며 모양이 바뀌어도 경계 후보로 붙이지 않는다', () => {
  const previousText = '장비가 크게 늘었습니다. 다른 지역도';
  const tail = '늘었습니다. 다른 지역도';
  const { detect } = createFakeDetect({
    [previousText]: [{ type: 'change', phrase: '크게 늘었습니다', start: 4, end: 12 }],
    [`${tail} 준비하고 있습니다.`]: [{ type: 'change', phrase: '늘었습니다', start: 0, end: 5 }],
  });
  const boundary = createBoundaryTrigger({ detect });
  boundary.detect({ text: previousText, startTs: 0, endTs: 3000 });
  const second = boundary.detect({ text: '준비하고 있습니다.', startTs: 3000, endTs: 6000 });
  assert.equal(second.boundaryCount, 0);
});

test('앞 조각이 꼬리 끝에서 이미 잡은 구와 겹치면 다른 유형이어도 경계 후보로 붙이지 않는다', () => {
  const previousText = '결국 1년 총액이 더 높';
  const tail = '총액이 더 높';
  const { detect } = createFakeDetect({
    [previousText]: [{ type: 'change', phrase: '더 높', start: 10, end: 13 }],
    [`${tail} 는 겁니다.`]: [{ type: 'adjective_noun', phrase: '높 는 겁', start: 6, end: 11 }],
  });
  const boundary = createBoundaryTrigger({ detect });
  boundary.detect({ text: previousText, startTs: 0, endTs: 3000 });
  const second = boundary.detect({ text: '는 겁니다.', startTs: 3000, endTs: 4000 });
  assert.equal(second.boundaryCount, 0);
});

test('비교 기준이 앞 조각에 있어 뒷조각만으로는 안 잡히던 비교를 경계 후보로 붙인다', { skip: !hasKiwiModel }, () => {
  const boundary = createBoundaryTrigger({ detect: kiwiTrigger.detect });
  assert.deepEqual(phraseListOf(boundary.detect({ text: '퀵 정렬이 버블 정렬보다 훨씬', startTs: 0, endTs: 3000 })), []);
  const second = boundary.detect({ text: '훨씬 빠릅니다. 그래서 실무에서 많이 씁니다.', startTs: 3000, endTs: 6000 });
  assert.equal(second.boundaryCount, 1);
  assert.equal(second.candidateList[0].type, 'change');
});
