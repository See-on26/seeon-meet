import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSpeechTrigger, TRIGGER_TYPE_MAP } = require('../src/main/caption-pipeline/trigger/speech-trigger.js');
const { createKiwiTokenizer } = require('../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');

// 맛 형용사 + 것·거("단 거", "단거", "짠 게", "매운 건")는 먹을거리 전체를 이르는 말이라 화면 속 대상을 가리키지 않는다.
// 판단 LLM 이 X 라고 해도 근거 확인이 뒤집어 엉뚱한 해설이 나갈 수 있어 후보부터 뽑지 않는다.
const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
let kiwiTrigger = null;

before(async () => {
  if (!hasKiwiModel) return;
  const tokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await tokenizer.load();
  kiwiTrigger = createSpeechTrigger({ tokenizer });
});

const { adjectiveNoun, demonstrative } = TRIGGER_TYPE_MAP;

function candidatePairListOf(text) {
  return kiwiTrigger.detect({ text }).candidateList.map((candidate) => [candidate.type, candidate.phrase]);
}

function phraseListOf(text, type) {
  return kiwiTrigger.detect({ text }).candidateList.filter((candidate) => candidate.type === type).map((candidate) => candidate.phrase);
}

const JELLY_UTTERANCE = '아니 너희들 건강은 어떻게 하려고 그런 거 그렇게 단거 먹고 막 그러면은 어? 이게 이게 말이 뭐 단짠 단짠';

test('"그렇게 단거 먹고" 발화에서 "단거"는 후보가 아니고, 같은 발화의 지시대명사 후보는 그대로다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(candidatePairListOf(JELLY_UTTERANCE), [
    [demonstrative, '그렇게'], [demonstrative, '이게'], [demonstrative, '이게'],
  ]);
});

test('맛 형용사 + 것·거·게·건은 띄어 쓰든 붙여 쓰든 형용사 + 지시 명사 후보가 아니다', { skip: !hasKiwiModel }, () => {
  for (const text of [
    '그렇게 단 거 먹고',
    '단거 먹고 막',
    '단 게 당긴다',
    '단 건 안 돼',
    '단것만 먹어',
    '단걸 좋아해요',
    '단 것을 줄이세요',
    '짠 거 먹지 마',
    '짠거 좋아해요',
    '짠 걸 너무 많이 먹어요',
    '매운 거 먹으면',
    '매운거 좋아해',
    '신 거 싫어',
    '쓴 거 먹었어',
    '달달한 거 땡긴다',
    '달콤한 게 좋아',
    '짭짤한 게 좋아',
    '매콤한 건 별로',
    '새콤한 거 먹고 싶다',
    '느끼한 거 많이 먹으면',
    '싱거운 건 싫어',
  ]) {
    assert.deepEqual(phraseListOf(text, adjectiveNoun), [], text);
  }
});

test('맛 형용사 후보를 거른 문장에서도 지시대명사·다른 후보는 남는다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(candidatePairListOf('단 거 말고 이거 보세요'), [[demonstrative, '이거']]);
  assert.deepEqual(phraseListOf('짠 걸 너무 많이 먹어요', TRIGGER_TYPE_MAP.scale), ['너무 많이 먹어요']);
});

test('색·크기·온도처럼 화면 속 대상을 가리는 형용사 + 것·거는 그대로 후보다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(phraseListOf('빨간 거 보세요', adjectiveNoun), ['빨간 거']);
  assert.deepEqual(phraseListOf('큰 거 하나 주세요', adjectiveNoun), ['큰 거']);
  assert.deepEqual(phraseListOf('뜨거운 거 조심하세요', adjectiveNoun), ['뜨거운 거']);
  assert.deepEqual(phraseListOf('빨간 건 매출이고 파란 건 비용이에요', adjectiveNoun), ['빨간 건', '파란 건']);
});
