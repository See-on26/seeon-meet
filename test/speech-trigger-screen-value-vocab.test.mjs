import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSpeechTrigger, detectEnglishCandidateList, TRIGGER_TYPE_MAP } = require('../src/main/caption-pipeline/trigger/speech-trigger.js');
const { createKiwiTokenizer } = require('../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');

// 효과영상(발화 기반 23자리)과 이해도 평가 DB S 진단(탐지 누락 27문항)에서 놓친 화면 값 표현.
// 사례 문장은 그 자리의 말을 바꿔 쓴 것이다(평가 문장 그대로 넣지 않는다).
const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
let kiwiTrigger = null;

before(async () => {
  if (!hasKiwiModel) return;
  const tokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await tokenizer.load();
  kiwiTrigger = createSpeechTrigger({ tokenizer });
});

const { number, change, scale } = TRIGGER_TYPE_MAP;

function phraseListOf({ candidateList, type }) {
  return candidateList.filter((candidate) => candidate.type === type).map((candidate) => candidate.phrase);
}

function detectKorean({ text, type }) {
  return phraseListOf({ candidateList: kiwiTrigger.detect({ text }).candidateList, type });
}

function detectEnglish({ text, type }) {
  return phraseListOf({ candidateList: detectEnglishCandidateList({ text }), type });
}

test('단위 없는 화면 값: 부호 붙은 수와 소수가 섞인 숫자 나열', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '기울기 추정치가 마이너스 0.87 이 값입니다.', type: number }), ['마이너스 0.87']);
  assert.deepEqual(detectKorean({ text: '보시면 12.4, 8.1 이렇게 나와요.', type: number }), ['12.4, 8.1']);
  assert.deepEqual(detectEnglish({ text: "Let's try minus three and run it again.", type: number }), ['minus three']);
  assert.deepEqual(detectEnglish({ text: 'The two groups came out at 4.2, 3.7 respectively.', type: number }), ['4.2, 3.7']);
});

test('단위 없는 화면 값: 소수 없는 나열과 천 단위 쉼표는 수치 후보가 아니다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '1, 2, 3 순서대로 누르세요.', type: number }), []);
  assert.deepEqual(detectEnglish({ text: 'Steps 1, 2 and 3 are the same.', type: number }), []);
});

test('한국어 변화: 보이는 사실을 말하는 관형형("~는 것을 볼 수 있다", "~다는 사실")은 꾸밈이 아니라 서술이다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '전력량이 솟구치는 게 보이죠.', type: change }), ['솟구치는']);
  assert.deepEqual(detectKorean({ text: '두 집단의 점수도 차이가 있는 것을 볼 수 있습니다.', type: change }), ['차이가 있는']);
  assert.deepEqual(detectKorean({ text: '두 선이 일정하게 평행선을 그리는 걸 확인할 수 있어요.', type: change }), ['일정하게 평행선을 그리는']);
  assert.deepEqual(detectKorean({ text: '아침 산책은 수면 개선에 도움이 되지 않는다는 사실.', type: change }), ['도움이 되지']);
});

test('한국어 변화: 관형형이 짐작("것으로 보입니다")이나 일반 명사를 꾸미면 후보가 아니다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '이번 결과가 가장 궁금하실 것으로 보입니다.', type: change }), []);
  assert.deepEqual(detectKorean({ text: '지난달 줄인 예산은 다시 늘립니다.', type: change }), []);
  assert.deepEqual(detectKorean({ text: '이 자료가 도움이 됐으면 좋겠습니다.', type: change }), []);
});

test('한국어 비교: 훨씬·더욱 같은 비교 부사 뒤 술어', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '설정 뒤에는 소비량도 훨씬 적게 들면서 유지됩니다.', type: change }), ['훨씬 적게 들면서']);
});

test('한국어 척도: 정도 관용구·큰 크기 형용사·강조 부사 + 척도 형용사 꾸밈말, 척도 형용사 + 변화 명사', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '와, 이건 진짜 장난 아니네요.', type: scale }), ['장난 아니네요']);
  assert.deepEqual(detectKorean({ text: '유난히 커다란 항아리가 보입니다.', type: scale }), ['유난히 커다란 항아리가']);
  assert.deepEqual(detectKorean({ text: '그 시절 그릇은 크기가 어마어마했습니다.', type: scale }), ['어마어마했습니다']);
  assert.deepEqual(detectKorean({ text: '내년에도 많은 성장입니다.', type: change }), ['많은 성장입니다']);
  assert.deepEqual(detectKorean({ text: '지방 정부가 엄청난 고통을 겪고 있어요.', type: scale }), []);
});

test('한국어 비율: "예외 없이"는 "모두"와 같은 비율 말이다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '예외 없이 모든 지역이 그랬습니다.', type: scale }), ['예외 없이']);
});

test('영어 비율·양: majority, a bunch of, a number of, mostly clustered (흔한 a lot of·some 은 넣지 않는다)', () => {
  assert.deepEqual(detectEnglish({ text: 'The vast majority of visitors are under 30.', type: scale }), ['The vast majority']);
  assert.deepEqual(detectEnglish({ text: 'This column has a bunch of different values.', type: scale }), ['a bunch of']);
  assert.deepEqual(detectEnglish({ text: 'With a number of people in their 70s as well.', type: scale }), ['a number of']);
  assert.deepEqual(detectEnglish({ text: 'Most cases are mostly clustered in their 50s.', type: scale }), ['mostly clustered']);
  assert.deepEqual(detectEnglish({ text: 'We saw a lot of people and some cars.', type: scale }), []);
  assert.deepEqual(detectEnglish({ text: 'It went up virtually every time we tried.', type: scale }), []);
});

test('영어 비교: exceed, below/above + 수, 최상급, than 없는 비교급 + 값 명사', () => {
  assert.deepEqual(detectEnglish({ text: 'By December the admissions exceed the first wave.', type: change }), ['exceed']);
  assert.deepEqual(detectEnglish({ text: 'The ratio stayed flat and below one.', type: change }), ['below one']);
  assert.deepEqual(detectEnglish({ text: 'This region has the highest share.', type: change }), ['the highest']);
  assert.deepEqual(detectEnglish({ text: 'Higher admission rates show up in the oldest group.', type: change }), ['Higher admission rates']);
  assert.deepEqual(detectEnglish({ text: 'The curve plateaued in May.', type: change }), ['plateaued']);
});
