// 요약 음성용 숫자 읽기. 요약 글은 아라비아 숫자로 두고(모델이 한글로 풀면 값을 틀린다), 합성 직전에만 읽는 말로 바꾼다.
// 음성 서버(MeloTTS)는 소수("16.1을")·쉼표 숫자("4,043")·큰 단위("238억")·조사 앞 정수("12를")를 잘못 읽는다.
// 날짜(년·월·일)와 고유어로 세는 말(개·명·장…) 앞의 정수는 음성 서버가 맞게 읽고, 바꾸면 "6월 → 육월"처럼
// 틀린 읽기가 되므로 그대로 둔다. 어떻게 읽을지 정할 수 없는 꼴(버전·날짜 점 표기·시각·전화번호·영문 단위가 붙은 수)은
// 반쯤 바꾸면 더 틀리므로 통째로 음성 서버에 맡긴다.

const DIGIT_WORD_LIST = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const PLACE_WORD_LIST = ['', '십', '백', '천'];
const GROUP_WORD_LIST = ['', '만', '억', '조', '경'];

// 정수 그대로 두는 뒤말(날짜·고유어 수 단위). 소수·쉼표 숫자는 이 뒤말이어도 바꾼다.
// 한자어로 읽는 말이 앞부분만 같은 경우(달러·배럴·개월·개국)는 막는다.
const KEEP_INTEGER_SUFFIX_PATTERN = /^(년|월|일|개(?!월|국)|명|시간|시|번|곳|가지|장|살|마리|권|달(?!러)|사람|배(?!럴)|차례|군데|잔|벌|켤레|척|채|그루|송이)/;

// 앞이 숫자·영문·점·쉼표가 아닌 자리에서 시작하는 수(부호·쉼표·소수·%·%p 포함). 뒤에 영문이 붙거나(5G·12.5km)
// 점·쉼표로 수가 더 이어지면(1.2.3·2024.3.15) 낱말·날짜의 일부라 잡지 않는다. 뒷말은 빈칸 하나를 건너 본다(3 명).
const NUMBER_PATTERN = /(^|[^0-9A-Za-z.,])(-)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%p|%)?(?![0-9A-Za-z]|[.,]\d)(?=\s?([가-힣]*))/g;
// 범위·나열(2~3개, 1, 2, 3번)은 마지막 수 뒤의 말로 판정한다.
const RANGE_TAIL_PATTERN = /^(?:\s*(?:[~∼〜–-]|,\s*)\s*\d+)+\s?([가-힣]*)/;
// 음수 부호는 글 맨 앞·빈칸·여는 괄호 뒤에서만 본다. 한글 뒤 하이픈(3월-6월, 가-1)은 이음표다.
const MINUS_LEAD_PATTERN = /^$|[\s(\[]/;
const DOLLAR_PATTERN = /\$\s*([\d,.]+)/g;
const LATIN_PATTERN = /[A-Za-z]/;
const DIGIT_PATTERN = /\d/;

function readGroup(groupValue) {
  const digitList = String(groupValue).padStart(4, '0').split('').map(Number);
  return digitList.map((digit, index) => {
    if (digit === 0) return '';
    const place = PLACE_WORD_LIST[3 - index];
    return `${digit === 1 && place ? '' : DIGIT_WORD_LIST[digit]}${place}`;
  }).join('');
}

// 0 이상 정수(BigInt)를 한자어 수로 읽는다. 만 단위로 끊어 띄우고, 만 앞의 일은 읽지 않는다(15000 → 만 오천).
// 읽을 단위(경)를 넘는 수는 null 이다.
function readSinoKoreanNumber(value) {
  if (value === 0n) return DIGIT_WORD_LIST[0];
  const partList = [];
  let rest = value;
  for (let groupIndex = 0; rest > 0n; groupIndex += 1) {
    if (groupIndex >= GROUP_WORD_LIST.length) return null;
    const groupValue = Number(rest % 10000n);
    rest /= 10000n;
    if (groupValue === 0) continue;
    const groupText = groupValue === 1 && groupIndex === 1 ? '' : readGroup(groupValue);
    partList.unshift(`${groupText}${GROUP_WORD_LIST[groupIndex]}`);
  }
  return partList.join(' ');
}

function readDecimalDigits(digitText) {
  return digitText.split('').map((digit) => DIGIT_WORD_LIST[Number(digit)]).join('');
}

// 하이픈으로 이어진 수의 맨 앞이 0 이면(010-1234-5678) 전화번호 같은 번호다.
function isInZeroLedChain({ whole, offset }) {
  let start = offset;
  while (start > 0 && /[\d-]/.test(whole[start - 1])) start -= 1;
  return whole[start] === '0';
}

// 읽을 말을 정할 수 없어 그대로 둘 수인가(시각·앞자리 0·번호·영문 이름에 붙은 수).
function isLeftAsIs({ rawLead, integerText, offset, matchLength, whole }) {
  const before = whole[offset - 1] || '';
  const after = whole.slice(offset + matchLength, offset + matchLength + 2);
  if (rawLead === ':' && DIGIT_PATTERN.test(before)) return true;
  if (after[0] === ':' && DIGIT_PATTERN.test(after[1] || '')) return true;
  if (integerText.length > 1 && integerText.startsWith('0')) return true;
  if (rawLead === '-' && LATIN_PATTERN.test(before)) return true;
  return rawLead === '-' && DIGIT_PATTERN.test(before) && isInZeroLedChain({ whole, offset });
}

function readNumbersForSpeech({ text, language = 'ko' }) {
  if (language !== 'ko') return text;
  // "$100"은 기존 음성 정리가 "100달러"로 옮기는데, 숫자를 먼저 바꾸면 그 옮기기가 맞지 않아 달러가 빠진다.
  const dollarText = String(text || '').replace(DOLLAR_PATTERN, '$1달러');
  return dollarText.replace(NUMBER_PATTERN, (match, rawLead, rawMinus, integerText, decimalText, percentText, suffix, offset, whole) => {
    if (isLeftAsIs({ rawLead, integerText, offset, matchLength: match.length, whole })) return match;
    const isMinus = Boolean(rawMinus) && MINUS_LEAD_PATTERN.test(rawLead);
    const lead = rawMinus && !isMinus ? `${rawLead}-` : rawLead;
    const rangeTail = RANGE_TAIL_PATTERN.exec(whole.slice(offset + match.length));
    const unitSuffix = rangeTail ? rangeTail[1] : suffix;
    const hasComma = integerText.includes(',');
    if (!decimalText && !hasComma && !percentText && !isMinus && KEEP_INTEGER_SUFFIX_PATTERN.test(unitSuffix)) return match;
    const integerWord = readSinoKoreanNumber(BigInt(integerText.replace(/,/g, '')));
    if (integerWord === null) return match;
    const decimalWord = decimalText ? ` 점 ${readDecimalDigits(decimalText.slice(1))}` : '';
    const percentWord = percentText === '%p' ? ' 퍼센트포인트' : percentText === '%' ? ' 퍼센트' : '';
    return `${lead}${isMinus ? '마이너스 ' : ''}${integerWord}${decimalWord}${percentWord}`;
  });
}

module.exports = { readSinoKoreanNumber, readNumbersForSpeech };
