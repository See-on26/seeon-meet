import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSpeechTrigger, detectEnglishCandidateList, TRIGGER_TYPE_MAP } = require('../src/main/caption-pipeline/trigger/speech-trigger.js');
const { createKiwiTokenizer } = require('../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');

// QA 2-14: 탐지 평가 DB 어휘 목록 밖 표현도 후보로 잡는다. 사례는 탐지 평가 DB 2차(train·val)와 「어휘 밖 표현」 세트(train·val)에서 왔다.
const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
let kiwiTrigger = null;

before(async () => {
  if (!hasKiwiModel) return;
  const tokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await tokenizer.load();
  kiwiTrigger = createSpeechTrigger({ tokenizer });
});

const { adjectiveNoun, number, change } = TRIGGER_TYPE_MAP;

function phraseListOf({ candidateList, type }) {
  return candidateList.filter((candidate) => candidate.type === type).map((candidate) => candidate.phrase);
}

function detectKorean({ text, type }) {
  return phraseListOf({ candidateList: kiwiTrigger.detect({ text }).candidateList, type });
}

function detectEnglish({ text, type }) {
  return phraseListOf({ candidateList: detectEnglishCandidateList({ text }), type });
}

test('한국어 변화: 줄어든 꼴로 한 덩어리가 된 형용사+어지다(커지다·나빠지다·흐려지다)와 동사로 분석된 싸지다도 잡는다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '별접기 시편의 압축 하중은 결국 커졌어요.', type: change }), ['결국 커졌어요']);
  assert.deepEqual(detectKorean({ text: '수율이 지난달부터 나빠졌어요.', type: change }), ['나빠졌어요']);
  assert.deepEqual(detectKorean({ text: '경계선이 점점 흐려졌습니다.', type: change }), ['점점 흐려졌습니다']);
  assert.deepEqual(detectKorean({ text: '부품값이 꽤 싸졌어요.', type: change }), ['꽤 싸졌어요']);
});

test('한국어 형용사 + 지시 명사: 부사로 분석된 어근 + 하다(뾰족한 거)도 형용사로 본다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '뾰족한 거 하나를 윤곽대로 그리세요.', type: adjectiveNoun }), ['뾰족한 거']);
});

test('영어 변화: 목록 밖 변화 동사(expanded·contracted·stretched out·shifted to·came in below·dropped off)', () => {
  assert.deepEqual(detectEnglish({ text: "The railway museum's restoration queue expanded.", type: change }), ['expanded']);
  assert.deepEqual(detectEnglish({ text: "The festival's radio dead zone contracted.", type: change }), ['contracted']);
  assert.deepEqual(detectEnglish({ text: "The screenprinting stencil's service life stretched out.", type: change }), ['stretched out']);
  assert.deepEqual(detectEnglish({ text: "Lyra's absorption peak shifted to a longer wavelength.", type: change }), ['shifted to']);
  assert.deepEqual(detectEnglish({ text: 'The footbridge repaint ultimately came in below the estimate.', type: change }), ['ultimately came in below']);
  assert.deepEqual(detectEnglish({ text: "The cable crew's rework hours dropped off.", type: change }), ['dropped off']);
});

test('영어 변화: 목적어를 받는 같은 동사(내려놓기·계약·옮기기)와 현재형 drop off 는 후보가 아니다', () => {
  for (const text of [
    'We dropped off the samples at the lab.',
    'This is where shoppers drop off.',
    'We contracted a local vendor for the repairs.',
    'We shifted the meeting to Friday.',
    'They expanded their team last spring.',
  ]) {
    assert.deepEqual(detectEnglish({ text, type: change }), [], text);
  }
});

test('영어 단순 수치: 목록 밖 단위(rpm·kWh), 하이픈 단위(newton-meters), square·cubic 단위', () => {
  assert.deepEqual(detectEnglish({ text: 'The measured rotation rate is 420 rpm.', type: number }), ['420 rpm']);
  assert.deepEqual(detectEnglish({ text: 'The meter total is 1.7 kWh.', type: number }), ['1.7 kWh']);
  assert.deepEqual(detectEnglish({ text: 'The wrench reading was 9.6 newton-meters.', type: number }), ['9.6 newton-meters']);
  assert.deepEqual(detectEnglish({ text: 'The measured area is 73 square meters.', type: number }), ['73 square meters']);
});

test('영어 형용사 + 지시 명사: 하이픈 형용사(the longer-lasting one)', () => {
  assert.deepEqual(detectEnglish({ text: "I'd assign the entrance crew the longer-lasting one.", type: adjectiveNoun }), ['the longer-lasting one']);
});
