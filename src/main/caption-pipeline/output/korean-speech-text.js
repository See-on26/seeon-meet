// TTS 로 보내는 한국어 글의 숫자·세는 말·단위를 읽는 말로 바꾼다. 화면 캡션·기록·중복 거르기·어절 예산은 원문을 쓰고,
// 음성 요청 글에만 씌운다. 음성 엔진(MeloTTS·Ming·Qwen)마다 숫자 읽기 규칙이 달라("카드 4장" → 사장/네 장,
// "10.9g" → 십.9g) 엔진 쪽에서 맞추면 대신 읽는 엔진으로 넘어갈 때 다시 틀린다. 그래서 앱에서 한 번 바꿔 같은 글을 보낸다.
// 순서: 제N(한자어) → 단위 → 범위 + 세는 말 → 세는 말 → 나머지 수(readNumbersForSpeech: 소수·쉼표·큰 수·조사 앞 정수·%).
const { readSinoKoreanNumber, readNumbersForSpeech } = require('../../summary/speech-number');

const DIGIT_WORD_LIST = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
// 세는 말 앞의 고유어 수(관형형): 한 개·두 명·스무 장·스물한 개.
const NATIVE_ONE_LIST = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
const NATIVE_TEN_LIST = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
const NATIVE_MAX = 99;
// 시각은 열두 시까지만 고유어로 읽는다(13시 → 십삼 시).
const NATIVE_HOUR_MAX = 12;
// 붙은 작은 수 짝은 관용형으로 읽는다(2~3개 → 두세 개).
const RANGE_IDIOM_MAP = {
  '1-2': '한두', '2-3': '두세', '3-4': '서너', '4-5': '네다섯', '5-6': '대여섯', '6-7': '예닐곱', '7-8': '일고여덟',
};

// 고유어로 세는 말. "대"(20대 = 이십대)와 "번"(3번 슬라이드 = 삼번, 3번 반복 = 세 번)은 뜻이 둘이라 넣지 않는다.
// 개월·개국·개년, 시즌·시리즈는 한자어로 읽거나 세는 말이 아니다. 개년은 한자어로 읽도록 따로 받는다.
const SINO_COUNTER = '개년';
const COUNTER_PATTERN_TEXT = `번째|${SINO_COUNTER}|개(?!월|국|년)|명|장|가지|살|시간|시(?!즌|리즈)|마리|권|잔|병|곳|군데|켤레|그루|송이|벌`;
const HOUR_COUNTER = '시';
const ORDINAL_COUNTER = '번째';

const NUMBER_TEXT = '(\\d{1,3}(?:,\\d{3})+|\\d+)';
const RANGE_SEPARATOR_TEXT = '[~∼〜–-]';
// 앞이 영문·숫자·점·쉼표면 낱말이나 더 긴 수의 일부다(Q3·A100·1.5·3,000). 세는 말 쪽은 범위 기호 뒤의 수도 건드리지 않는다.
const UNIT_LEAD_TEXT = '(^|[^0-9A-Za-z.,])';
const COUNTER_LEAD_TEXT = '(^|[^0-9A-Za-z.,~∼〜–-])';

// 제N 은 한자어 서수다(제4장 → 제사 장). 낱말 속 "제"(문제3개)는 서수가 아니라 낱말 첫머리만 본다.
const ORDINAL_PATTERN = /(^|[^0-9A-Za-z가-힣])제(\d{1,4})(?![0-9.,%A-Za-z])\s?(?=([가-힣])?)/g;

// g 는 소문자만(5G 통신), L 은 대문자만 본다. 단위 뒤에 영문·숫자가 이어지면(6.5GB·2.5GHz) 단위가 아니다.
// 조사 "이·가"는 뒤에 한글이 없을 때만 조사로 본다("1L이다"의 "이"는 서술격이고, "100g가량"의 "가"는 낱말이다).
const UNIT_WORD_MAP = {
  kcal: '킬로칼로리', kg: '킬로그램', mg: '밀리그램', g: '그램', mL: '밀리리터', ml: '밀리리터', L: '리터',
  km: '킬로미터', cm: '센티미터', mm: '밀리미터',
};
const UNIT_PATTERN = new RegExp(
  `${UNIT_LEAD_TEXT}${NUMBER_TEXT}(\\.\\d+)?(?:\\s*${RANGE_SEPARATOR_TEXT}\\s*${NUMBER_TEXT}(\\.\\d+)?)?\\s?`
  + '(kcal|kg|mg|mL|ml|km|cm|mm|g|L)(?![A-Za-z0-9])(으로|은|는|을|를|과|와|로|이(?![가-힣])|가(?![가-힣]))?',
  'g',
);
// 단위 글자("g"=지)를 보고 붙인 조사를 단위 말("그램")의 받침에 맞춘다.
const PARTICLE_AFTER_FINAL_MAP = { 는: '은', 가: '이', 를: '을', 와: '과', 로: '으로' };
const PARTICLE_AFTER_VOWEL_MAP = { 은: '는', 이: '가', 을: '를', 과: '와', 으로: '로' };

const RANGE_COUNTER_PATTERN = new RegExp(
  `${COUNTER_LEAD_TEXT}${NUMBER_TEXT}\\s*${RANGE_SEPARATOR_TEXT}\\s*${NUMBER_TEXT}(?![0-9.,%])\\s?(?=(${COUNTER_PATTERN_TEXT}))`,
  'g',
);
const COUNTER_PATTERN = new RegExp(`${COUNTER_LEAD_TEXT}${NUMBER_TEXT}(?![0-9.,%])\\s?(?=(${COUNTER_PATTERN_TEXT}))`, 'g');
const HANGUL_END_PATTERN = /[가-힣]$/;

function hasFinalConsonant(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 !== 0;
}

// 앞자리 0(05장)은 번호일 수 있어 읽을 말을 정하지 않는다.
function isZeroLed(integerText) {
  return integerText.length > 1 && integerText.startsWith('0');
}

function toInteger(integerText) {
  return Number(integerText.replace(/,/g, ''));
}

function readSino(integerText, decimalText = '') {
  const integerWord = readSinoKoreanNumber(BigInt(integerText.replace(/,/g, '')));
  if (integerWord === null) return null;
  if (!decimalText) return integerWord;
  return `${integerWord} 점 ${decimalText.slice(1).split('').map((digit) => DIGIT_WORD_LIST[Number(digit)]).join('')}`;
}

function readNative(value, counter) {
  if (value === 1 && counter === ORDINAL_COUNTER) return '첫';
  const ten = Math.floor(value / 10);
  const one = value % 10;
  if (ten === 2 && one === 0) return '스무';
  return `${NATIVE_TEN_LIST[ten]}${NATIVE_ONE_LIST[one]}`;
}

function isNativeReadable({ integerText, counter }) {
  if (integerText.includes(',') || isZeroLed(integerText) || counter === SINO_COUNTER) return false;
  const value = toInteger(integerText);
  const max = counter === HOUR_COUNTER ? NATIVE_HOUR_MAX : NATIVE_MAX;
  return value >= 1 && value <= max;
}

// 한글 바로 뒤에 붙은 수(카드4장)는 띄어 읽는다.
function spaceAfter(lead) {
  return HANGUL_END_PATTERN.test(lead) ? ' ' : '';
}

function fixParticle({ word, particle }) {
  if (!particle) return '';
  const particleMap = hasFinalConsonant(word) ? PARTICLE_AFTER_FINAL_MAP : PARTICLE_AFTER_VOWEL_MAP;
  return particleMap[particle] || particle;
}

function readOrdinal(text) {
  return text.replace(ORDINAL_PATTERN, (match, lead, integerText, nextHangul) => {
    if (isZeroLed(integerText)) return match;
    return `${lead}제${readSino(integerText)}${nextHangul ? ' ' : ''}`;
  });
}

function readUnit(text) {
  return text.replace(UNIT_PATTERN, (match, lead, fromText, fromDecimal, toText, toDecimal, unit, particle) => {
    if (isZeroLed(fromText) || (toText && isZeroLed(toText))) return match;
    const fromWord = readSino(fromText, fromDecimal);
    const toWord = toText ? readSino(toText, toDecimal) : '';
    if (fromWord === null || toWord === null) return match;
    const unitWord = UNIT_WORD_MAP[unit];
    const numberWord = toText ? `${fromWord}에서 ${toWord}` : fromWord;
    return `${lead}${spaceAfter(lead)}${numberWord} ${unitWord}${fixParticle({ word: unitWord, particle })}`;
  });
}

function readRangeCounter(text) {
  return text.replace(RANGE_COUNTER_PATTERN, (match, lead, fromText, toText, counter) => {
    if (isZeroLed(fromText) || isZeroLed(toText)) return match;
    const prefix = `${lead}${spaceAfter(lead)}`;
    if (isNativeReadable({ integerText: fromText, counter }) && isNativeReadable({ integerText: toText, counter })) {
      const idiom = counter === ORDINAL_COUNTER ? null : RANGE_IDIOM_MAP[`${toInteger(fromText)}-${toInteger(toText)}`];
      if (idiom) return `${prefix}${idiom} `;
      return `${prefix}${readNative(toInteger(fromText), counter)} ${counter}에서 ${readNative(toInteger(toText), counter)} `;
    }
    const fromWord = readSino(fromText);
    const toWord = readSino(toText);
    if (fromWord === null || toWord === null) return match;
    return `${prefix}${fromWord}에서 ${toWord} `;
  });
}

// 1~99 는 고유어, 100 이상·쉼표 수·개년은 한자어로 읽는다(엔진마다 다르게 읽으므로 숫자로 남기지 않는다). 0 과 앞자리 0 은 그대로 둔다.
function readCounter(text) {
  return text.replace(COUNTER_PATTERN, (match, lead, integerText, counter) => {
    if (isZeroLed(integerText) || toInteger(integerText) === 0) return match;
    const prefix = `${lead}${spaceAfter(lead)}`;
    if (isNativeReadable({ integerText, counter })) return `${prefix}${readNative(toInteger(integerText), counter)} `;
    const sinoWord = readSino(integerText);
    return sinoWord === null ? match : `${prefix}${sinoWord} `;
  });
}

function normalizeKoreanSpeechText(text) {
  const counterRead = readCounter(readRangeCounter(readUnit(readOrdinal(String(text ?? '')))));
  return readNumbersForSpeech({ text: counterRead, language: 'ko' });
}

module.exports = { normalizeKoreanSpeechText };
