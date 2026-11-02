import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSpeechTrigger, TRIGGER_TYPE_MAP } = require('../src/main/caption-pipeline/trigger/speech-trigger.js');
const { createKiwiTokenizer } = require('../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');

// 화면 속 대상을 가리키지 않는 말버릇 지시어를 트리거 단계에서 거른다: 정도를 세게 말하는 "그렇게", 조각 끝의 "그렇게",
// "이게 말이 ~" 관용구, "이게 이게" 말더듬.
// "그렇게" 바로 뒤에 형용사가 오면("그렇게 단 거", "그렇게 비싼 걸") 정도를 세게 말하는 말이라 화면 속 대상을 가리키지 않는다.
// 뒤에 동사가 오는 "그렇게 하면", "그렇게 접수할게요"는 앞에서 말한 방식을 가리켜 여럿 중 어느 것인지 물을 수 있어 그대로 둔다.
// 받아쓰기 조각이 "그렇게"로 끝나면 뒤 말을 몰라 정도인지 방식인지 가릴 수 없고, 판단도 뒤 문맥 없이 O 로 기울어 후보로 두지 않는다.
const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
let kiwiTrigger = null;

before(async () => {
  if (!hasKiwiModel) return;
  const tokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await tokenizer.load();
  kiwiTrigger = createSpeechTrigger({ tokenizer });
});

function demonstrativeListOf(text) {
  return kiwiTrigger.detect({ text }).candidateList
    .filter((candidate) => candidate.type === TRIGGER_TYPE_MAP.demonstrative)
    .map((candidate) => candidate.phrase);
}

test('"그렇게" 바로 뒤에 형용사가 오면 지시 후보가 아니다', { skip: !hasKiwiModel }, () => {
  for (const text of [
    '그렇게 단 거 먹고',
    '그렇게 단거 먹고 막',
    '그렇게 비싼 걸 왜 사',
    '그렇게 큰 차이는 아니에요',
    '그렇게 맛있는 걸 두고',
    '그렇게 달달한 거 먹으면',
    '그렇게 중요한 건 아니고',
  ]) {
    assert.deepEqual(demonstrativeListOf(text), [], text);
  }
});

test('받아쓰기 조각이 "그렇게"로 끝나 뒤에 오는 말이 없으면 지시 후보가 아니다', { skip: !hasKiwiModel }, () => {
  for (const text of [
    '아니 너희들 건강은 어떻게 하려고 그런 거 그렇게',
    '아 그렇게?',
  ]) {
    assert.deepEqual(demonstrativeListOf(text), [], text);
  }
  assert.deepEqual(demonstrativeListOf('사장님 최애 간식이 이거'), ['이거']);
});

test('"그렇게" 뒤에 동사가 오면(앞에서 말한 방식) 그대로 지시 후보다', { skip: !hasKiwiModel }, () => {
  for (const text of [
    '그렇게 하면 돼요',
    '행사 때는 그렇게 접수할게요',
    '그렇게 바꾸면 인쇄가 늦어져요',
    '안전장구는 그렇게 인수하겠습니다',
  ]) {
    assert.deepEqual(demonstrativeListOf(text), ['그렇게'], text);
  }
});

test('"이렇게·저렇게"는 뒤에 형용사가 와도 그대로 지시 후보다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(demonstrativeListOf('이렇게 높은 막대가 올해 매출이에요'), ['이렇게']);
  assert.deepEqual(demonstrativeListOf('저렇게 긴 줄은 처음 봐요'), ['저렇게']);
});

// "이게 말이 돼?", "이게 말이 단짠이지"처럼 지시어 + 주격 조사 + "말"은 말버릇(관용구)이고, "이게 이게"처럼 같은 지시어를
// 곧바로 되풀이한 앞의 것은 말더듬이다. 둘 다 화면 속 대상을 가리키지 않는다.
test('"이게 말이 ~" 관용구의 지시어는 후보가 아니다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(demonstrativeListOf('이게 말이 돼?'), []);
  assert.deepEqual(demonstrativeListOf('어? 이게 말이 단짠이지 이거 맨날'), ['이거']);
  assert.deepEqual(demonstrativeListOf('그게 말이죠'), []);
});

test('같은 지시어를 곧바로 되풀이하면 앞의 것은 후보가 아니고 뒤의 것만 남는다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(demonstrativeListOf('이거 이거 보세요'), ['이거']);
  assert.deepEqual(demonstrativeListOf('이게 이게 말이 뭐 단 단짠 단짠이지 이거 맨날'), ['이거']);
});

test('정답 해설 자리의 지시어는 그대로 후보다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(demonstrativeListOf('사장님 최애 간식이 이거 아닙니까?'), ['이거']);
  assert.deepEqual(demonstrativeListOf('자리에 항상 이게 있기 때문에'), ['이게']);
});
