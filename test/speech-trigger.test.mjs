import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createSpeechTrigger, detectEnglishCandidateList, detectKoreanCandidateListByRule, detectTriggerLanguage, TRIGGER_TYPE_MAP,
} = require('../src/main/caption-pipeline/trigger/speech-trigger.js');
const { createKiwiTokenizer } = require('../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');

// Kiwi 모델(npm run setup:kiwi)이 있어야 한국어 품사 규칙을 잰다. 없으면 그 시험만 건너뛴다.
const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
let kiwiTrigger = null;

before(async () => {
  if (!hasKiwiModel) return;
  const tokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await tokenizer.load();
  kiwiTrigger = createSpeechTrigger({ tokenizer });
});

function detectKorean(text) {
  return kiwiTrigger.detect({ text }).candidateList.map((candidate) => [candidate.type, candidate.phrase]);
}

function detectEnglish(text) {
  return detectEnglishCandidateList({ text }).map((candidate) => [candidate.type, candidate.phrase]);
}

const { demonstrative, adjectiveNoun, number, change, scale } = TRIGGER_TYPE_MAP;

test('조각의 언어는 한글과 영어 낱말 수로 정한다', () => {
  assert.equal(detectTriggerLanguage('이 부분에서 오류가 납니다'), 'ko');
  assert.equal(detectTriggerLanguage('This part is where most errors happen.'), 'en');
  assert.equal(detectTriggerLanguage('API 응답이 느려요'), 'ko');
});

test('한국어 지시대명사: 관형사+명사·대명사·이렇게만 잡고 주격조사 "이"·1인칭 "저"는 잡지 않는다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean('이 부분에서 오류가 제일 많이 납니다.'), [[demonstrative, '이 부분']]);
  assert.deepEqual(detectKorean('여기가 복원 실습 장소예요.'), [[demonstrative, '여기']]);
  assert.deepEqual(detectKorean('그렇게 하면 상대가 물러서요.'), [[demonstrative, '그렇게']]);
  assert.deepEqual(detectKorean('같이 표를 보면 저는 괜찮아요.'), []);
  assert.deepEqual(detectKorean('그 때는 몰랐어요.'), []);
});

test('한국어 형용사 + 지시 명사: 형용사 관형형 + 쪽·부분·거·것·곳, 동사 관형절은 빼다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean('두 안 중에 싼 쪽으로 가죠.'), [[adjectiveNoun, '싼 쪽']]);
  assert.deepEqual(detectKorean('어두운 부분은 다시 찍어야 해요.'), [[adjectiveNoun, '어두운 부분']]);
  assert.deepEqual(detectKorean('표시한 거 말고요.'), []);
});

test('한국어 단순 수치: 숫자 + 단위, 띄어 쓴 큰 수도 한 구로, 날짜·시각은 빼다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean('보시는 것처럼 30%예요.'), [[number, '30%']]);
  assert.deepEqual(detectKorean('총 12.5톤입니다.'), [[number, '12.5톤']]);
  assert.deepEqual(detectKorean('예산은 4억 5천만 원입니다.'), [[number, '4억 5천만 원']]);
  assert.deepEqual(detectKorean('2024년 3월에 시작했어요.'), []);
});

test('한국어 변화·비교·결론: 변화 술어·비교 술어를 부사어·결론 표지와 한 구로 잡는다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean('작년이랑 비교해 보면 많이 올랐습니다.'), [[change, '많이 올랐습니다']]);
  assert.deepEqual(detectKorean('사고 건수는 결국 감소했습니다.'), [[change, '결국 감소했습니다']]);
  assert.deepEqual(detectKorean('4조 빵이 2조 빵보다 결국 더 부풀었어요.'), [[change, '결국 더 부풀었어요']]);
  assert.deepEqual(detectKorean('평균 기록이 몰라보게 좋아졌어요.'), [[change, '몰라보게 좋아졌어요']]);
});

test('한국어 추상적 척도: 크다·넓다·많다 술어만, 비교·변화·관형형은 빼다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean('피해 지역이 꽤 넓죠.'), [[scale, '꽤 넓죠']]);
  assert.deepEqual(detectKorean('큰 차이는 없어요.'), []);
  assert.deepEqual(detectKorean('부지가 점점 넓어졌어요.'), [[change, '점점 넓어졌어요']]);
});

test('Kiwi 가 준비되지 않으면 한국어는 대체 규칙으로 잡는다', () => {
  const trigger = createSpeechTrigger({ tokenizer: { tokenize: () => null } });
  const result = trigger.detect({ text: '이 부분에서 30%가 늘었습니다.' });
  assert.equal(result.analyzer, 'rule');
  assert.ok(result.candidateList.some((candidate) => candidate.type === demonstrative));
  assert.ok(detectKoreanCandidateListByRule({ text: '피해 지역이 꽤 넓죠.' }).some((candidate) => candidate.type === scale));
});

test('영어 지시대명사: this·these·those + 명사, 가리키는 here·there, 접속사·존재문은 빼다', () => {
  assert.deepEqual(detectEnglish('These two shots are going into our report.'), [[demonstrative, 'These two shots']]);
  assert.deepEqual(detectEnglish("There's our bottleneck."), [[demonstrative, 'There']]);
  assert.deepEqual(detectEnglish("There's a problem with the build."), []);
  assert.deepEqual(detectEnglish('I think that we should wait.'), []);
  assert.deepEqual(detectEnglish("That's the one I need to talk about."), [[demonstrative, 'That']]);
});

test('영어 형용사 + 지시 명사·단순 수치', () => {
  assert.deepEqual(detectEnglish('I vote we order the cheaper ones.'), [[adjectiveNoun, 'the cheaper ones']]);
  assert.deepEqual(detectEnglish("As you can see, it's 18%."), [[number, '18%']]);
  assert.deepEqual(detectEnglish("We're projecting $86,000."), [[number, '$86,000']]);
  assert.deepEqual(detectEnglish('Let us look at 31 cups first.'), [[number, '31 cups']]);
});

test('영어 변화·비교·결론과 추상적 척도', () => {
  assert.deepEqual(detectEnglish('Contamination has fallen a lot since then.'), [[change, 'fallen a lot']]);
  assert.deepEqual(detectEnglish('Prima has been more reliable than Tanaka.'), [[change, 'more reliable than']]);
  assert.deepEqual(detectEnglish('Leasing ultimately came out cheaper.'), [[change, 'ultimately came out cheaper']]);
  assert.deepEqual(detectEnglish('Honestly, the cord is really short.'), [[scale, 'really short']]);
  assert.deepEqual(detectEnglish('There are way too many people on it.'), [[scale, 'way too many']]);
});
