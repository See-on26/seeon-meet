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

const { scale } = TRIGGER_TYPE_MAP;

test('한국어 추상적 척도: 목록 밖 척도 형용사(빠르다·얕다·무겁다 등)와 "~은 편이다"', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '동쪽 배수로가 다소 얕네요.', type: scale }), ['다소 얕네요']);
  assert.deepEqual(detectKorean({ text: '새 충전기는 충전 속도가 아주 빠릅니다.', type: scale }), ['아주 빠릅니다']);
  assert.deepEqual(detectKorean({ text: '견적이 상당히 비쌉니다.', type: scale }), ['상당히 비쌉니다']);
  assert.deepEqual(detectKorean({ text: '다리 아래는 수심이 깊은 편입니다.', type: scale }), ['깊은 편입니다']);
});

test('한국어 추상적 척도: 척도 부사(많이·대거·두껍게·넉넉하게) + 동사', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '올해는 신호 장비를 꽤 많이 설치했습니다.', type: scale }), ['꽤 많이 설치했습니다']);
  assert.deepEqual(detectKorean({ text: '주민분들이 대거 모였습니다.', type: scale }), ['대거 모였습니다']);
  assert.deepEqual(detectKorean({ text: '모래층이 두껍게 쌓였습니다.', type: scale }), ['두껍게 쌓였습니다']);
  assert.deepEqual(detectKorean({ text: '검정색 롱패딩이 넉넉하게 남아 있어요.', type: scale }), ['넉넉하게 남아']);
});

test('한국어 추상적 척도: 수 없는 비율 말(상당수가·대부분이·절반 이상이·거의 다·몇몇 조만)', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '응답자 상당수가 재택 병행을 원하고 있어요.', type: scale }), ['상당수가']);
  assert.deepEqual(detectKorean({ text: '신규 가맹점 대부분이 수도권에 있습니다.', type: scale }), ['대부분이']);
  assert.deepEqual(detectKorean({ text: '주문 절반 이상이 앱에서 들어왔어요.', type: scale }), ['절반 이상이']);
  assert.deepEqual(detectKorean({ text: '챙겨 간 샘플이 거의 다 나갔어요.', type: scale }), ['거의 다']);
  assert.deepEqual(detectKorean({ text: '몇몇 조만 기한 안에 냈어요.', type: scale }), ['몇몇 조만']);
});

test('한국어 추상적 척도: 계획·의지, 명사를 꾸미는 말, 남의 말 옮기기, 시간처럼 볼 수 없는 정도는 후보가 아니다', { skip: !hasKiwiModel }, () => {
  for (const text of [
    '마지막 인사는 길게 하지 않겠습니다.',
    '크게 걱정하실 필요는 없습니다.',
    '수학 문턱이 꽤 높다고들 하죠.',
    '교재 예제 일부는 건너뛰겠습니다.',
    '대부분 아시겠지만 수거함은 카드로 엽니다.',
    '자료 이관에 시간이 꽤 오래 걸렸습니다.',
    '말씀하신 내용에 상당 부분 공감합니다.',
  ]) {
    assert.deepEqual(detectKorean({ text, type: scale }), [], text);
  }
});

test('한국어 변화·비교·결론: 최상·극값(사상 최저·최하위·최상위권·바닥을 찍다·기록을 갈아치우다·가장 + 술어)', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '광고 전환율이 사상 최저를 기록했습니다.', type: change }), ['사상 최저를 기록했습니다']);
  assert.deepEqual(detectKorean({ text: '올해 평가에서 우리 구가 최하위를 기록했습니다.', type: change }), ['최하위를 기록했습니다']);
  assert.deepEqual(detectKorean({ text: '나물 반찬 세트가 재구매율 최상위권이에요.', type: change }), ['최상위권이에요']);
  assert.deepEqual(detectKorean({ text: '연휴 주간에 활성 사용자가 바닥을 찍었습니다.', type: change }), ['바닥을 찍었습니다']);
  assert.deepEqual(detectKorean({ text: '올여름 낮 기온이 기록을 갈아치웠습니다.', type: change }), ['기록을 갈아치웠습니다']);
  assert.deepEqual(detectKorean({ text: '설치 이후 진동 폭이 역대 최대였습니다.', type: change }), ['역대 최대였습니다']);
  assert.deepEqual(detectKorean({ text: '토요일 오후에 열람실이 가장 붐볐습니다.', type: change }), ['가장 붐볐습니다']);
});

test('한국어 변화·비교·결론: 비교 표지 없는 비교(밑돌다·비슷하다·우세하다·박빙이다·동률을 이루다·차이가 없다)', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '올해는 합격률이 전국 평균을 밑돌았어요.', type: change }), ['밑돌았어요']);
  assert.deepEqual(detectKorean({ text: '후보지끼리 공사비는 거의 비슷합니다.', type: change }), ['거의 비슷합니다']);
  assert.deepEqual(detectKorean({ text: '채널 가운데 자사몰이 우세합니다.', type: change }), ['우세합니다']);
  assert.deepEqual(detectKorean({ text: '두 지점 매출이 박빙이에요.', type: change }), ['박빙이에요']);
  assert.deepEqual(detectKorean({ text: '교통 분야에서 북구와 남구가 동률을 이뤘습니다.', type: change }), ['동률을 이뤘습니다']);
  assert.deepEqual(detectKorean({ text: '비료를 줘도 키는 차이가 없었어요.', type: change }), ['차이가 없었어요']);
});

test('한국어 변화·비교·결론: 추세 말(오름세·내림세·증가 추세)과 멈춤(주춤·정체·제자리걸음), 흑자로 돌아서다', { skip: !hasKiwiModel }, () => {
  assert.deepEqual(detectKorean({ text: '이번 달 연못 수온이 오름세를 보였어요.', type: change }), ['오름세를 보였어요']);
  assert.deepEqual(detectKorean({ text: '금형 교체 후 불량률이 내림세로 접어들었어요.', type: change }), ['내림세로 접어들었어요']);
  assert.deepEqual(detectKorean({ text: '매출이 증가 추세를 보이고 있습니다.', type: change }), ['증가 추세를 보이고']);
  assert.deepEqual(detectKorean({ text: '이번 달 들어 신규 가입이 주춤했어요.', type: change }), ['주춤했어요']);
  assert.deepEqual(detectKorean({ text: '두 분기 연속 판매가 정체됐습니다.', type: change }), ['정체됐습니다']);
  assert.deepEqual(detectKorean({ text: '반응 시간을 바꿔도 수율은 제자리걸음이에요.', type: change }), ['제자리걸음이에요']);
  assert.deepEqual(detectKorean({ text: '올해 운영 수지가 흑자로 돌아섰습니다.', type: change }), ['흑자로 돌아섰습니다']);
});

test('한국어 변화·비교·결론: 명사를 꾸미는 비교·극값, 목적의 "-도록", 계획, 기록 확인, 흐름 끊김은 후보가 아니다', { skip: !hasKiwiModel }, () => {
  for (const text of [
    '구민 여러분의 압도적인 성원에 감사드립니다.',
    '비슷한 맥락에서 창업 공간도 마련했습니다.',
    '온라인 참석자도 현장과 차이가 없도록 준비했습니다.',
    '진행 방식은 최소한의 원칙만 말씀드릴게요.',
    '올해도 최고의 결과를 내겠습니다.',
    '지난 기록을 확인했습니다.',
    '제 전화 때문에 흐름이 끊겼네요.',
  ]) {
    assert.deepEqual(detectKorean({ text, type: change }), [], text);
  }
});
