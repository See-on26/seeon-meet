import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSpeechTrigger, TRIGGER_TYPE_MAP } = require('../src/main/caption-pipeline/trigger/speech-trigger.js');
const { createKiwiTokenizer } = require('../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');

// 평가 형용사 말머리("재밌는 게 …")는 지시 후보에서 빼고, 단위 없이 값만 말한 소수("보시면 10.9")는 수치 후보로 넣는다.
const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
let kiwiTrigger = null;

before(async () => {
  if (!hasKiwiModel) return;
  const tokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await tokenizer.load();
  kiwiTrigger = createSpeechTrigger({ tokenizer });
});

const { adjectiveNoun, demonstrative, number } = TRIGGER_TYPE_MAP;

function phraseListOf(text, type) {
  return kiwiTrigger.detect({ text }).candidateList.filter((candidate) => candidate.type === type).map((candidate) => candidate.phrase);
}

test('평가 형용사 + 것·거 + 이·은 말머리("재밌는 게 …", "중요한 건 …")는 형용사 + 지시 명사 후보가 아니다', { skip: !hasKiwiModel }, () => {
  for (const text of [
    '재밌는 게 일본이 지금',
    '재밌는게 일본이 지금',
    '재미있는 건 비용이 줄었다는 거예요',
    '중요한 건 타이밍입니다.',
    '중요한 것은 순서입니다',
    '확실한 건 지금 바꿔야 한다는 거죠',
    '분명한 건 비용이에요',
    '궁금한 건 일정이에요',
    '아쉬운 게 예산이 없어요',
    '안타까운 건 예산이에요',
  ]) {
    assert.deepEqual(phraseListOf(text, adjectiveNoun), [], text);
  }
});

test('말머리를 거른 문장에서도 같은 문장의 지시대명사는 남는다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(phraseListOf('놀라운 건 이 수치예요', adjectiveNoun), []);
  assert.deepEqual(phraseListOf('놀라운 건 이 수치예요', demonstrative), ['이 수치']);
  assert.deepEqual(phraseListOf('놀라운 게 이거예요', demonstrative), ['이거']);
});

test('성질로 가리는 형용사, 눈에 띄는 모양을 말하는 형용사, 목적어·다른 조사 자리의 평가 형용사는 그대로 후보다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(phraseListOf('빨간 거 보세요', adjectiveNoun), ['빨간 거']);
  assert.deepEqual(phraseListOf('빨간 건 매출이고 파란 건 비용이에요', adjectiveNoun), ['빨간 건', '파란 건']);
  assert.deepEqual(phraseListOf('큰 게 작년 거예요', adjectiveNoun), ['큰 게']);
  assert.deepEqual(phraseListOf('신기한 게 하나 있어요', adjectiveNoun), ['신기한 게']);
  assert.deepEqual(phraseListOf('재밌는 거 하나 보여 드릴게요', adjectiveNoun), ['재밌는 거']);
  assert.deepEqual(phraseListOf('재밌는 것만 골랐어요', adjectiveNoun), ['재밌는 것']);
});

test('단위 없이 말한 소수는 단순 수치 후보다(받아쓰기가 붙인 마침표·괄호 꼴 포함)', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(phraseListOf('근데 보시면 10.9', number), ['10.9']);
  assert.deepEqual(phraseListOf('소금이. 근데 보시면 10.9', number), ['10.9']);
  assert.deepEqual(phraseListOf('9.3 거의 2배 가까이 돼.', number), ['9.3', '2배']);
  assert.deepEqual(phraseListOf('9.3. 거의 2배 가까이.', number), ['9.3', '2배']);
  assert.deepEqual(phraseListOf('9.3(.) 거의 2배 가까이', number), ['9.3', '2배']);
  assert.deepEqual(phraseListOf('근데 보시면 10.9, 9.3, 거의 2배 가까이 돼요.', number), ['10.9', '9.3', '2배']);
  assert.deepEqual(phraseListOf('결과는 0.82가 나왔습니다.', number), ['0.82']);
});

test('마침표가 붙은 소수 후보의 자리는 숫자까지만이다', { skip: !hasKiwiModel }, () => {
  const [candidate] = kiwiTrigger.detect({ text: '9.3. 거의' }).candidateList.filter((entry) => entry.type === number);
  assert.deepEqual([candidate.phrase, candidate.start, candidate.end], ['9.3', 0, 3]);
});

test('이름표 소수·날짜·버전·정수 나열·순번 단위 소수는 단위 없는 수치 후보가 아니고, 단위가 붙은 소수는 한 구 그대로다', { skip: !hasKiwiModel }, () => {
  for (const text of ['앱 3.2 버전 업데이트 이후로', '2024.10.23. 회의록입니다', '버전은 1.2.3이에요', '1, 2, 3 순서로 보세요', '3.5년 걸렸어요']) {
    assert.deepEqual(phraseListOf(text, number), [], text);
  }
  assert.deepEqual(phraseListOf('총 12.5톤입니다.', number), ['12.5톤']);
  assert.deepEqual(phraseListOf('전환율은 3.2%가 나왔어요.', number), ['3.2%']);
});
