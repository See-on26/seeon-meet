// 발표자가 어림해 말한 수("약 800", "3천 명쯤", "800여 명")를 찾는다. 해설이 그 어림 값을 되풀이하지 않고 화면에 글자로 적힌
// 값을 말하게 프롬프트에서 짚어 주고, OCR 줄 고르기에서 어림 값에 가까운 수가 든 줄을 먼저 넣는 데 쓴다.
const NUMBER_SOURCE = '\\d[\\d,]*(?:\\.\\d+)?\\s*(?:천|만|억|조)?';
const UNIT_SOURCE = '(?:%|퍼센트|프로|개월|시간|명|개|건|원|달러|배|점|분|초|일|년|km|kg|m|톤|도|대|곳|회|번|위|세|주)?';
const PREFIX_SOURCE = '(?:약|대략|대충|얼추|거의|한|어림잡아|대강|about|around|roughly|approximately|nearly|almost)';
const SUFFIX_SOURCE = '(?:정도|쯤|가량|남짓|안팎|내외|넘게|넘는|가까이|언저리|or so|-?ish|plus)';
// 앞말은 낱말 첫머리에서만 본다("대한 800건"의 '한', "요약 800자"의 '약'은 어림이 아니다).
const APPROXIMATE_VALUE_PATTERN = new RegExp([
  `(?<![가-힣A-Za-z])${PREFIX_SOURCE}\\s*${NUMBER_SOURCE}\\s*${UNIT_SOURCE}(?:\\s*${SUFFIX_SOURCE})?`,
  `${NUMBER_SOURCE}\\s*(?:여\\s*${UNIT_SOURCE}|${UNIT_SOURCE}\\s*${SUFFIX_SOURCE})`,
].join('|'), 'gi');
const NUMBER_PATTERN = new RegExp(NUMBER_SOURCE, 'g');
const MULTIPLIER_MAP = { 천: 1e3, 만: 1e4, 억: 1e8, 조: 1e12 };
// 어림 값과 화면 값의 차이 허용 폭. 발표자는 대개 앞 한두 자리로 반올림해 말한다(2,870 → "3천쯤").
const NEAR_RATIO = 0.15;

function parseNumber(text) {
  const match = String(text || '').match(/(\d[\d,]*(?:\.\d+)?)\s*(천|만|억|조)?/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, '')) * (MULTIPLIER_MAP[match[2]] || 1);
  return Number.isFinite(value) ? value : null;
}

function extractApproximateValueList(text) {
  const resultList = [];
  for (const match of String(text || '').matchAll(APPROXIMATE_VALUE_PATTERN)) {
    const phrase = match[0].trim();
    const value = parseNumber(phrase);
    if (value !== null && !resultList.some((item) => item.phrase === phrase)) resultList.push({ phrase, value });
  }
  return resultList;
}

function isNearApproximateValue({ text, approximateValueList = [] }) {
  if (!approximateValueList.length) return false;
  const valueList = (String(text || '').match(NUMBER_PATTERN) || []).map(parseNumber).filter((value) => value !== null);
  return valueList.some((value) => approximateValueList.some((item) => item.value > 0
    && Math.abs(value - item.value) / item.value <= NEAR_RATIO));
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
      + '(예: 발화 "3천 명쯤" + 화면 "2,870명" → 2,870명).',
    hasChartEstimate ? CHART_APPROXIMATE_FALLBACK_LINE : SPEECH_APPROXIMATE_FALLBACK_LINE,
  ].join('\n');
}

// 어림 값이 없어도 두는 일반 규칙. 발화의 수는 받아쓰기 오류일 수도 있다.
const SCREEN_VALUE_FIRST_RULE = '    발표자가 말한 수치는 어림했거나 잘못 들린 것일 수 있다. 화면에 글자로 적힌 값과 다르면 화면에 적힌 값을 쓴다.';

module.exports = {
  extractApproximateValueList, isNearApproximateValue, buildApproximateValueLine, SCREEN_VALUE_FIRST_RULE,
};
