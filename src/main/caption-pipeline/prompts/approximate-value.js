// 발표자가 어림해 말한 수("약 3천", "3천 명쯤", "40여 명")를 찾는다. 해설이 그 어림 값을 되풀이하지 않고 화면에 글자로 적힌
// 값을 말하게 프롬프트에서 짚어 주고, OCR 줄 고르기에서 어림 값에 가까운 수가 든 줄을 먼저 넣는 데 쓴다.
// 범위("3~4배")는 한 덩어리로 읽어 가운데 값을 쓴다. 영어 배수(thousand·million·billion·k·M)도 읽는다.
const SINGLE_NUMBER_SOURCE = '\\d[\\d,]*(?:\\.\\d+)?';
const MULTIPLIER_SOURCE = '(?:\\s*(?:천|만|억|조)|\\s*(?:thousand|million|billion)\\b|(?:k|K|M|B)\\b)';
const NUMBER_SOURCE = `${SINGLE_NUMBER_SOURCE}${MULTIPLIER_SOURCE}?(?:\\s*[~\\-–]\\s*${SINGLE_NUMBER_SOURCE}${MULTIPLIER_SOURCE}?)?`;
// 영어 단위(km·kg·m)는 낱말 첫머리("1.2 million"의 m)가 아닐 때만 단위로 본다.
const UNIT_SOURCE = '(?:%|퍼센트|프로|개월|시간|명|개|건|원|달러|배|점|분|초|일|년|(?:km|kg|m)(?![A-Za-z])|톤|도|대|곳|회|번|위|세|주)?';
const PREFIX_SOURCE = '(?:약|대략|대충|얼추|거의|한|어림잡아|대강|about|around|roughly|approximately|nearly|almost)';
const SUFFIX_SOURCE = '(?:정도|쯤|가량|남짓|안팎|내외|넘게|넘는|가까이|언저리|or so|-?ish|plus)';
// 앞말은 낱말 첫머리에서만 본다("대한 600건"의 '한', "요약 600자"의 '약'은 어림이 아니다).
// "여"는 수에 바로 붙고 뒤에 낱말이 이어지지 않을 때만 어림 꼬리다("40여 명", "40여명"은 어림, "3 여기"는 아니다).
const APPROXIMATE_VALUE_PATTERN = new RegExp([
  `(?<![가-힣A-Za-z])${PREFIX_SOURCE}\\s*${NUMBER_SOURCE}\\s*${UNIT_SOURCE}(?:\\s*${SUFFIX_SOURCE})?`,
  `${NUMBER_SOURCE}(?:여(?:\\s*(?:명|개|건|원|곳|회|번|대|일|년|개월|시간|분|가지)|(?![가-힣]))|\\s*${UNIT_SOURCE}\\s*${SUFFIX_SOURCE})`,
].join('|'), 'gi');
const NUMBER_PATTERN = new RegExp(`${SINGLE_NUMBER_SOURCE}${MULTIPLIER_SOURCE}?`, 'g');
const MULTIPLIER_MAP = {
  천: 1e3, 만: 1e4, 억: 1e8, 조: 1e12, thousand: 1e3, million: 1e6, billion: 1e9, k: 1e3, m: 1e6, b: 1e9,
};
// 어림 값과 화면 값의 차이 허용 폭. 발표자는 대개 앞 한두 자리로 반올림해 말한다(2,870 → "3천쯤").
const NEAR_RATIO = 0.15;
// 연도("거의 2020년부터", "around 2019")는 어림한 양이 아니다 — 수가 1900~2099 이고 뒤에 단위가 없거나 '년'일 때.
const YEAR_LIKE_PATTERN = /^(?:19|20)\d{2}$/;
const YEAR_UNIT_PATTERN = /^\s*(?:년)?$/;
const SUFFIX_TAIL_PATTERN = new RegExp(`\\s*${SUFFIX_SOURCE}$`, 'i');
const PARSE_NUMBER_PATTERN = new RegExp(`(${SINGLE_NUMBER_SOURCE})(?:\\s*(천|만|억|조)|\\s*(thousand|million|billion)\\b|(k|K|M|B)\\b)?`);

function parseNumber(text) {
  const match = String(text || '').match(PARSE_NUMBER_PATTERN);
  if (!match) return null;
  const multiplierWord = String(match[2] || match[3] || match[4] || '').toLowerCase();
  const value = Number(match[1].replace(/,/g, '')) * (MULTIPLIER_MAP[multiplierWord] || 1);
  return Number.isFinite(value) ? value : null;
}

// 범위("3~4배")는 두 끝의 가운데 값으로 본다.
function parseApproximateNumber(phrase) {
  const numberList = (String(phrase).match(NUMBER_PATTERN) || []).map(parseNumber).filter((value) => value !== null);
  if (!numberList.length) return null;
  return numberList.length >= 2 ? (numberList[0] + numberList[1]) / 2 : numberList[0];
}

function isYearPhrase(phrase) {
  const numberMatch = String(phrase).match(/\d[\d,]*(?:\.\d+)?/);
  if (!numberMatch || !YEAR_LIKE_PATTERN.test(numberMatch[0])) return false;
  const unitText = String(phrase).slice(numberMatch.index + numberMatch[0].length).replace(SUFFIX_TAIL_PATTERN, '');
  return YEAR_UNIT_PATTERN.test(unitText);
}

function extractApproximateValueList(text) {
  const resultList = [];
  for (const match of String(text || '').matchAll(APPROXIMATE_VALUE_PATTERN)) {
    const phrase = match[0].trim();
    const value = parseApproximateNumber(phrase);
    if (value !== null && !isYearPhrase(phrase) && !resultList.some((item) => item.phrase === phrase)) resultList.push({ phrase, value });
  }
  return resultList;
}

function isNearValue({ value, reference }) {
  return reference > 0 && Math.abs(value - reference) / reference <= NEAR_RATIO;
}

function isNearApproximateValue({ text, approximateValueList = [] }) {
  if (!approximateValueList.length) return false;
  const valueList = (String(text || '').match(NUMBER_PATTERN) || []).map(parseNumber).filter((value) => value !== null);
  return valueList.some((value) => approximateValueList.some((item) => isNearValue({ value, reference: item.value })));
}

// 값→의미의 값 칸은 발표자가 말한 그 수를 읽는다. 화면 값을 쓰게 하면 옆 막대·다른 항목의 값으로 바꿔 써도 값 검사(화면에 있나)를
// 통과하므로, 값 칸의 수가 발화의 수와 같거나 그 ±15% 안일 때만 받는다(어림 값 "약 3천" ↔ 화면 2,870). 발화에 아라비아 숫자가
// 없거나 값 칸에 숫자가 없으면 견줄 수 없다(unchecked).
const SPOKEN_VALUE_VERDICT_MAP = { near: 'near', far: 'far', unchecked: 'unchecked' };

function checkSpokenValueMatch({ value, utterance }) {
  const valueNumberList = (String(value || '').match(NUMBER_PATTERN) || []).map(parseNumber).filter((number) => number !== null);
  const spokenNumberList = [
    ...extractApproximateValueList(utterance).map((item) => item.value),
    ...(String(utterance || '').match(NUMBER_PATTERN) || []).map(parseNumber),
  ].filter((number) => number !== null);
  if (!valueNumberList.length || !spokenNumberList.length) return { verdict: SPOKEN_VALUE_VERDICT_MAP.unchecked, reason: '' };
  const isNear = valueNumberList.some((number) => spokenNumberList.some((spoken) => number === spoken
    || isNearValue({ value: number, reference: spoken })));
  return isNear
    ? { verdict: SPOKEN_VALUE_VERDICT_MAP.near, reason: '' }
    : { verdict: SPOKEN_VALUE_VERDICT_MAP.far, reason: `발화 수=${[...new Set(spokenNumberList)].join(',')}` };
}

const SPEECH_APPROXIMATE_FALLBACK_LINE = '  화면에 글자로 적힌 값이 없을 때만 발화의 어림 값을 쓰고, 막대·선 높이를 눈금으로 어림해 새 값을 만들지 않는다.';
// 시스템이 잰 「그래프 어림값」 덩어리가 같은 프롬프트(덩어리는 이 줄 아래)에 들어갈 때 쓰는 줄. 덩어리는 발화의 어림 값과 다르면
// 어림값을 쓰라고 하므로, 적힌 값 다음으로 그래프 어림값을 쓰게 해 두 줄이 다른 값을 고르지 않게 한다. 모델이 직접 눈금을 읽는 것은 여전히 막는다.
const CHART_APPROXIMATE_FALLBACK_LINE = '  화면에 글자로 적힌 값이 없으면 아래 「그래프 어림값」을 쓰고, 거기에도 없을 때만 발화의 어림 값을 쓴다.'
  + ' 「그래프 어림값」에 없는 막대·선 높이를 눈금으로 어림해 새 값을 만들지는 않는다.';

// 어림 값이 있을 때 프롬프트에 넣는 줄. 범위는 화면에 글자로 적힌 값이고, 막대·선 높이를 눈금으로 읽어 새 값을 만들지는 않게 한다.
// hasChartEstimate: 그래프 어림값 덩어리가 함께 들어가면 적힌 값이 없을 때 발화의 어림 값보다 그 값을 먼저 쓰게 한다.
function buildApproximateValueLine(approximateValueList = [], { hasChartEstimate = false } = {}) {
  if (!approximateValueList.length) return '';
  return [
    `발표자는 수치를 어림해 말했다: ${approximateValueList.map((item) => `"${item.phrase}"`).join(', ')}.`
      + ' 화면에 그 대상의 값이 글자로 적혀 있으면 어림 값 대신 화면에 적힌 값을 그대로 쓴다'
      + '(예: 발화 "3천 명쯤" + 화면 "2,870명" → 2,870명). 어림 값과 크게 다른 수는 다른 대상의 값이니 쓰지 않는다.',
    hasChartEstimate ? CHART_APPROXIMATE_FALLBACK_LINE : SPEECH_APPROXIMATE_FALLBACK_LINE,
  ].join('\n');
}

// 어림 값이 없어도 두는 일반 규칙. 발화의 수는 받아쓰기 오류일 수도 있지만, 화면 값으로 바꾸는 것은 같은 대상의 값이 아주 가까울 때뿐이다.
// "다르면 화면 값"으로만 두면 어림 표지 없는 정확한 발화 수도 옆 막대·다른 항목의 화면 값으로 바꿔 쓰게 부추겼다.
const SCREEN_VALUE_FIRST_RULE = '    발표자가 말한 수치가 화면에 글자로 적힌 같은 대상의 값과 조금 다르면(어림했거나 잘못 들린 것으로 보일 만큼 가까우면)'
  + ' 화면에 적힌 값을 쓴다. 크게 다른 값이나 다른 대상(옆 막대·다른 항목)의 값으로 바꾸지 않는다.';

module.exports = {
  extractApproximateValueList, isNearApproximateValue, buildApproximateValueLine, checkSpokenValueMatch, SPOKEN_VALUE_VERDICT_MAP,
  SCREEN_VALUE_FIRST_RULE,
};
