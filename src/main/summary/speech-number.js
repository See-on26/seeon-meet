// 요약 음성용 숫자 읽기. 요약 글은 아라비아 숫자로 두고(모델이 한글로 풀면 값을 틀린다), 합성 직전에만 읽는 말로 바꾼다.
// 음성 서버(MeloTTS)는 소수("16.1을")·쉼표 숫자("4,043")·큰 단위("238억")·조사 앞 정수("12를")를 잘못 읽는다.
// 날짜(년·월·일)와 고유어로 세는 말(개·명·장…) 앞의 정수는 음성 서버가 맞게 읽고, 바꾸면 "6월 → 육월"처럼
// 틀린 읽기가 되므로 그대로 둔다.

const DIGIT_WORD_LIST = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const PLACE_WORD_LIST = ['', '십', '백', '천'];
const GROUP_WORD_LIST = ['', '만', '억', '조', '경'];

// 정수 그대로 두는 뒤말(날짜·고유어 수 단위). 소수·쉼표 숫자는 이 뒤말이어도 바꾼다.
const KEEP_INTEGER_SUFFIX_PATTERN = /^(년|월|일|개|명|시간|시|번|곳|가지|장|살|마리|권|달|사람|배|차례|군데|잔|벌|켤레|척|채|그루|송이)/;

// 앞이 숫자·영문·점·쉼표가 아닌 자리에서 시작하는 수(부호·쉼표·소수·%·%p 포함). 뒤에 영문이 붙으면(5G) 낱말의 일부다.
const NUMBER_PATTERN = /(^|[^0-9A-Za-z.,])(-)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%p|%)?(?![0-9A-Za-z])(?=([가-힣]*))/g;

function readGroup(groupValue) {
  const digitList = String(groupValue).padStart(4, '0').split('').map(Number);
  return digitList.map((digit, index) => {
    if (digit === 0) return '';
    const place = PLACE_WORD_LIST[3 - index];
    return `${digit === 1 && place ? '' : DIGIT_WORD_LIST[digit]}${place}`;
  }).join('');
}

// 0 이상 정수(BigInt)를 한자어 수로 읽는다. 만 단위로 끊어 띄우고, 만 앞의 일은 읽지 않는다(15000 → 만 오천).
function readSinoKoreanNumber(value) {
  if (value === 0n) return DIGIT_WORD_LIST[0];
  const partList = [];
  let rest = value;
  for (let groupIndex = 0; rest > 0n; groupIndex += 1) {
    const groupValue = Number(rest % 10000n);
    rest /= 10000n;
    if (groupValue === 0) continue;
    const groupWord = GROUP_WORD_LIST[groupIndex] ?? '';
    const groupText = groupValue === 1 && groupIndex === 1 ? '' : readGroup(groupValue);
    partList.unshift(`${groupText}${groupWord}`);
  }
  return partList.join(' ');
}

function readDecimalDigits(digitText) {
  return digitText.split('').map((digit) => DIGIT_WORD_LIST[Number(digit)]).join('');
}

function readNumbersForSpeech({ text, language = 'ko' }) {
  if (language !== 'ko') return text;
  return String(text || '').replace(NUMBER_PATTERN, (match, lead, minus, integerText, decimalText, percentText, suffix) => {
    const hasComma = integerText.includes(',');
    if (!decimalText && !hasComma && !percentText && !minus && KEEP_INTEGER_SUFFIX_PATTERN.test(suffix)) return match;
    const integerWord = readSinoKoreanNumber(BigInt(integerText.replace(/,/g, '')));
    const decimalWord = decimalText ? ` 점 ${readDecimalDigits(decimalText.slice(1))}` : '';
    const percentWord = percentText === '%p' ? ' 퍼센트포인트' : percentText === '%' ? ' 퍼센트' : '';
    return `${lead}${minus ? '마이너스 ' : ''}${integerWord}${decimalWord}${percentWord}`;
  });
}

module.exports = { readSinoKoreanNumber, readNumbersForSpeech };
