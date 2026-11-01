// TTS 로 보내는 한국어 글의 숫자·세는 말·단위를 읽는 말로 바꾸고, 소리 내면 거슬리는 꼴(낱말 사이 대시·괄호 속 영문 풀이)을
// 다듬는다. 화면 캡션·기록·중복 거르기·어절 예산은 원문을 쓰고,
// 음성 요청 글에만 씌운다. 음성 엔진(MeloTTS·Ming·Qwen)마다 숫자 읽기 규칙이 달라("카드 4장" → 사장/네 장,
// "10.9g" → 십.9g) 엔진 쪽에서 맞추면 대신 읽는 엔진으로 넘어갈 때 다시 틀린다. 그래서 앱에서 한 번 바꿔 같은 글을 보낸다.
// 순서: 괄호 속 영문 풀이 빼기 → 낱말 사이 대시를 쉼표로 → 제N(한자어) → 단위 → 범위 + 세는 말 → 세는 말
// → 나머지 수(readNumbersForSpeech: 소수·쉼표·큰 수·조사 앞 정수·%) → 낱자 영문.
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

// 낱자로 떨어진 영문자("A, 3, J, 4", "A사")는 한글 이름으로 읽는다. Ming 은 낱자 영문이 섞인 문장에서 끝맺지 못하고 웅얼거리는
// 일이 잦았다. 영문·숫자·&·하이픈·작은따옴표에 붙은 글자(GPU, Q3, 5G, e-mail, AT&T)는 단어라 그대로 둔다.
// 숫자·단위를 읽은 뒤에 바꿔 "%p"·"10.9g" 의 글자는 이미 읽는 말이 되어 있다.
const LATIN_LETTER_NAME_MAP = {
  A: '에이', B: '비', C: '씨', D: '디', E: '이', F: '에프', G: '지', H: '에이치', I: '아이', J: '제이', K: '케이', L: '엘', M: '엠',
  N: '엔', O: '오', P: '피', Q: '큐', R: '알', S: '에스', T: '티', U: '유', V: '브이', W: '더블유', X: '엑스', Y: '와이', Z: '제트',
};
const LONE_LATIN_LETTER_PATTERN = /(?<![A-Za-z0-9&'’-])([A-Za-z])(?![A-Za-z0-9&'’-])/g;

function readLoneLatinLetter(text) {
  return text.replace(LONE_LATIN_LETTER_PATTERN, (letter) => LATIN_LETTER_NAME_MAP[letter.toUpperCase()]);
}

// 한글 낱말 바로 뒤(빈칸 하나까지) 괄호에 영문으로 덧붙인 풀이("섭취량(Current Status)을", "금융불안지수(FSI)의")는 읽지 않는다.
// 음성 엔진이 영문을 소리 나는 대로 앞뒤에 이어 붙여("…킛스테이터스를") 알아듣기 어렵고, 앞 한글 낱말이 같은 뜻을 이미 말한다.
// 영문자로 시작하고 영문 두 글자 이상이 이어진 괄호만 풀이로 본다. 한글이 든 괄호(하루 기준), 글 맨 앞·영문 뒤 괄호,
// 숫자로 시작하는 괄호(10.9g), 낱자 이름표(A)·영문 낱자 + 숫자(Q3)는 내용이라 그대로 둔다.
// 숫자·낱자 영문을 읽기 전에 빼야 괄호 속 숫자·글자가 한글로 바뀌어 풀이로 보이지 않게 되는 일이 없다.
const LATIN_GLOSS_PATTERN = /([가-힣])[ \t]?\(([A-Za-z][A-Za-z0-9 .,'’&/:-]*)\)/g;
const LATIN_WORD_PATTERN = /[A-Za-z]{2}/;

function dropLatinGloss(text) {
  return text.replace(LATIN_GLOSS_PATTERN, (match, hangul, gloss) => (LATIN_WORD_PATTERN.test(gloss) ? hangul : match));
}

// 낱말 사이에 띄어 쓴 하이픈·대시(" - ", " – ", " — ")는 항목과 내용을 가르는 표시라 쉼표로 읽는다. 그대로 두면 음성 엔진이
// "마이너스"로 읽는다. 빈칸 없이 붙은 하이픈(-0.11%, COVID-19, e-mail, 3월-6월)과 양쪽이 숫자인 범위·뺄셈(2 - 3개)은
// 건드리지 않는다. 앞에 문장 부호가 있으면(비교표: - 왼쪽) 쉼표를 덧붙이지 않고 대시만 뺀다.
// 범위 + 세는 말(2 - 3개 → 두세 개)을 읽기 전에 바꾸되, 양쪽이 숫자인 꼴은 남겨 그 읽기에 맡긴다.
const SPACED_DASH_PATTERN = /(\S)[ \t]+[-–—][ \t]+(?=(\S))/g;
const DIGIT_CHAR_PATTERN = /\d/;
const CLAUSE_PUNCTUATION_PATTERN = /[,.;:!?]/;

function readSpacedDash(text) {
  return text.replace(SPACED_DASH_PATTERN, (match, before, after) => {
    if (DIGIT_CHAR_PATTERN.test(before) && DIGIT_CHAR_PATTERN.test(after)) return match;
    return CLAUSE_PUNCTUATION_PATTERN.test(before) ? `${before} ` : `${before}, `;
  });
}

function normalizeKoreanSpeechText(text) {
  const separatorRead = readSpacedDash(dropLatinGloss(String(text ?? '')));
  const counterRead = readCounter(readRangeCounter(readUnit(readOrdinal(separatorRead))));
  return readLoneLatinLetter(readNumbersForSpeech({ text: counterRead, language: 'ko' }));
}

module.exports = { normalizeKoreanSpeechText };
