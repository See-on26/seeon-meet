import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSpeechTrigger, detectEnglishCandidateList, TRIGGER_TYPE_MAP } = require('../src/main/caption-pipeline/trigger/speech-trigger.js');
const { createKiwiTokenizer } = require('../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');

// 값의 변화·화면 수치가 아닌데 트리거가 후보로 뽑던 말(계획·의지 어미, 이름·순번, 관용구 등)을 거른다.
const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
let kiwiTrigger = null;

before(async () => {
  if (!hasKiwiModel) return;
  const tokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await tokenizer.load();
  kiwiTrigger = createSpeechTrigger({ tokenizer });
});

const { demonstrative, number, change } = TRIGGER_TYPE_MAP;

function detectKorean(text) {
  return kiwiTrigger.detect({ text }).candidateList.map((candidate) => [candidate.type, candidate.phrase]);
}

function detectEnglish(text) {
  return detectEnglishCandidateList({ text }).map((candidate) => [candidate.type, candidate.phrase]);
}

function typeListOf(pairList, type) {
  return pairList.filter(([candidateType]) => candidateType === type).map(([, phrase]) => phrase);
}

test('한국어: 계획·의지·청유로 말한 늘리기·줄이기는 변화 후보가 아니다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(typeListOf(detectKorean('그 팀은 다음 달에 인원을 줄이겠습니다.'), change), []);
  assert.deepEqual(typeListOf(detectKorean('그 지점은 내년에 직원을 늘립니다.'), change), []);
  assert.deepEqual(typeListOf(detectKorean('이 버튼을 아래로 내려 보세요.'), change), []);
  assert.deepEqual(typeListOf(detectKorean('다음 주부터 직원을 더 배치할게요.'), change), []);
  assert.deepEqual(typeListOf(detectKorean('회의를 한 번 더 해요.'), change), []);
  assert.deepEqual(typeListOf(detectKorean('입구에 의자를 하나 더 두죠.'), change), []);
});

test('한국어: 관형형으로 명사를 꾸미는 변화 동사는 후보가 아니지만 뒤의 비교 술어는 남는다', { skip: !hasKiwiModel }, () => {
  const pairList = detectKorean('가격을 줄인 상품이 결국 더 잘 팔렸어요.');
  assert.ok(!typeListOf(pairList, change).some((phrase) => phrase.includes('줄인')));
  assert.ok(typeListOf(pairList, change).some((phrase) => phrase.includes('팔렸어요')));
});

test('한국어: 지난 일로 말한 변화는 그대로 후보다', { skip: !hasKiwiModel }, () => {
  assert.ok(typeListOf(detectKorean('작년보다 비용이 줄었어요.'), change).length > 0);
  assert.ok(typeListOf(detectKorean('인원을 두 배로 늘렸습니다.'), change).length > 0);
  assert.ok(typeListOf(detectKorean('매출이 많이 올랐습니다.'), change).length > 0);
  assert.ok(typeListOf(detectKorean('A팀이 B팀보다 더 빨랐어요.'), change).length > 0);
});

test('한국어: 조·분기·호점 같은 이름·순번과 고유어 개수, 기준 단위는 수치 후보가 아니다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(typeListOf(detectKorean('2조는 4분기에 3호점을 엽니다.'), number), []);
  assert.deepEqual(typeListOf(detectKorean('책상 두 대를 들이고 의자 세 개를 샀어요.'), number), []);
  assert.deepEqual(typeListOf(detectKorean('불만이 한 건도 없었어요.'), number), []);
  assert.deepEqual(typeListOf(detectKorean('쌀은 1kg에 4,000원입니다.'), number), ['4,000원']);
});

test('한국어: 화면 수치는 그대로 후보다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(typeListOf(detectKorean('전환율은 3.2%가 나왔어요.'), number), ['3.2%']);
  assert.deepEqual(typeListOf(detectKorean('총 52곳이에요.'), number), ['52곳']);
  assert.deepEqual(typeListOf(detectKorean('3조 원 규모입니다.'), number).length, 1);
});

test('한국어: 앞말에 붙어 쓴 "이"는 지시어로 자르지 않는다', { skip: !hasKiwiModel }, () => {
  const pairList = detectKorean('자막 없이 들은 반이 자막을 켠 반보다 성적이 더 잘 나왔어요.');
  assert.deepEqual(typeListOf(pairList, demonstrative), []);
  assert.deepEqual(typeListOf(detectKorean('이 부분을 보시면 됩니다.'), demonstrative), ['이 부분']);
});

test('영어: 주어 명사로 쓰인 변화 낱말은 후보가 아니지만 뒤 술어는 남는다', () => {
  assert.deepEqual(typeListOf(detectEnglish('Shrink has gone up with the new gates.'), change), ['gone up']);
  assert.deepEqual(typeListOf(detectEnglish('Crashes went down after the patch.'), change), ['went down']);
});

test('영어: 값의 변화가 아닌 구동사·관용구는 후보가 아니다', () => {
  for (const text of [
    'That feature was cut from the roadmap.',
    'The trench they cut is very deep.',
    'We will drop the old sensor here.',
    'This is where shoppers drop off.',
    'The bridge falls apart in winter.',
    'The app crashed twice during the demo.',
    'We open the new site next fall.',
    'What jumped out at me was the cost.',
    'The growing season here is short.',
  ]) {
    assert.deepEqual(typeListOf(detectEnglish(text), change), [], text);
  }
});

test('영어: 기간을 나타내는 over the N weeks 는 수치 후보가 아니다', () => {
  const pairList = detectEnglish('Scores rose over the eight weeks.');
  assert.deepEqual(typeListOf(pairList, number), []);
  assert.deepEqual(typeListOf(pairList, change), ['rose']);
});

test('영어: 값의 변화는 그대로 후보다', () => {
  assert.ok(typeListOf(detectEnglish('Sales dropped a lot last year.'), change).length > 0);
  assert.ok(typeListOf(detectEnglish('Returns dropped a ton after the redesign.'), change).length > 0);
  assert.ok(typeListOf(detectEnglish('The wait has dropped a great deal.'), change).length > 0);
  assert.ok(typeListOf(detectEnglish('And the frog numbers have crashed.'), change).length > 0);
  assert.ok(typeListOf(detectEnglish('Occupancy jumped right after the reopening.'), change).length > 0);
  assert.ok(typeListOf(detectEnglish('Costs were cut by 30%.'), change).length > 0);
});
