// 수치 해설 프롬프트에 넣는 "그래프 어림값" 덩어리. 시스템이 세로축 눈금과 막대 높이로 잰 값이고 화면에 적힌 숫자가 아니다.
// 어림값이 있을 때(그래프 어림 ok)만 만든다. 없으면 빈 덩어리라 프롬프트는 글자 하나까지 그대로다.
const { CAPTION_LANGUAGE_MAP } = require('../contracts/caption-language');

// 통화 기호는 숫자 앞에, 나머지 단위(%, 만, g …)는 숫자 뒤에 붙인다.
const PREFIX_UNIT_PATTERN = /^[$₩€£¥]$/;

const CHART_BLOCK_TEXT_MAP = {
  [CAPTION_LANGUAGE_MAP.ko]: {
    intro: ({ range }) => `참고: 그래프 어림값 — 화면의 세로 막대그래프를 시스템이 세로축 눈금(${range})과 막대 높이로 잰 값이다. 화면에 적힌 숫자가 아니다.`,
    range: ({ min, max, step }) => `${min}~${max}, ${step} 간격`,
    noGridline: ' (눈금선 없음, 오차가 더 클 수 있다)',
    barList: ({ barCount, entryList }) => `  막대 ${barCount}개, 왼쪽부터: ${entryList.join(' · ')}`,
    approximate: '약',
    usageLineList: [
      '  이 막대들의 값을 말할 때는 축 눈금 숫자가 아니라 이 어림값에 "약"을 붙여 쓴다. 발표자가 어림해 말한 수와 다르면 이 어림값을 쓴다.',
      '  화면에 그 막대의 값이 숫자로 적혀 있으면 적힌 값을 쓴다. 이미지의 그래프와 막대 수·순서가 맞지 않으면 이 값을 쓰지 않는다.',
    ],
  },
  [CAPTION_LANGUAGE_MAP.en]: {
    intro: ({ range }) => `Note: chart estimates — the system measured the vertical bar chart on screen against its y-axis ticks (${range}) and bar heights; these numbers are not printed on screen.`,
    range: ({ min, max, step }) => `${min}–${max}, step ${step}`,
    noGridline: ' (no gridlines, the error may be larger)',
    barList: ({ barCount, entryList }) => `  ${barCount} bars, left to right: ${entryList.join(' · ')}`,
    approximate: 'about',
    usageLineList: [
      '  When giving a bar\'s value use these with "about", not an axis tick number. If the speaker\'s rough figure differs, use this estimate.',
      '  If a bar\'s value is printed on screen, use the printed value. If the chart in the image does not match this bar count or order, do not use these values.',
    ],
  },
};

const formatNumber = (value) => Number(value).toLocaleString('en-US', { maximumFractionDigits: 6 });

function formatValueWithUnit({ value, unit }) {
  if (!unit) return formatNumber(value);
  return PREFIX_UNIT_PATTERN.test(unit) ? `${unit}${formatNumber(value)}` : `${formatNumber(value)}${unit}`;
}

function buildChartEstimateBlock({ chart, language = CAPTION_LANGUAGE_MAP.ko }) {
  if (chart?.status !== 'ok' || !chart.valueList?.length) return { text: '', barCount: 0 };
  const textMap = CHART_BLOCK_TEXT_MAP[language] || CHART_BLOCK_TEXT_MAP[CAPTION_LANGUAGE_MAP.ko];
  const range = textMap.range({ min: formatNumber(chart.tickMin), max: formatNumber(chart.tickMax), step: formatNumber(chart.step) });
  const entryList = chart.valueList.map((entry) => {
    const approximate = `${textMap.approximate} ${formatValueWithUnit({ value: entry.value, unit: chart.unit })}`;
    return entry.label ? `${entry.label} ${approximate}` : approximate;
  });
  const lineList = [
    `${textMap.intro({ range })}${chart.isSnapped ? '' : textMap.noGridline}`,
    textMap.barList({ barCount: chart.valueList.length, entryList }),
    ...textMap.usageLineList,
  ];
  return { text: lineList.join('\n'), barCount: chart.valueList.length };
}

// 블록이 있을 때만 수치 규칙에 붙이는 예외. 규칙 (1)은 추정을 금지하고, 변화·비교는 화면에 수치가 없으면 NONE 이다.
const CHART_ESTIMATE_RULE_EXCEPTION_MAP = {
  [CAPTION_LANGUAGE_MAP.ko]: ' 단, 위 「그래프 어림값」은 시스템이 잰 값이라 "약"을 붙여 쓸 수 있다.',
  [CAPTION_LANGUAGE_MAP.en]: ' 단, 위 「그래프 어림값」은 시스템이 잰 값이라 "about"을 붙여 쓸 수 있다.',
};
const CHART_ESTIMATE_SCREEN_VALUE_LINE = '그래프 어림값이 있으면 그 값이 화면의 수치다.';

function readChartEstimateRuleException(language) {
  return CHART_ESTIMATE_RULE_EXCEPTION_MAP[language] || CHART_ESTIMATE_RULE_EXCEPTION_MAP[CAPTION_LANGUAGE_MAP.ko];
}

module.exports = { buildChartEstimateBlock, readChartEstimateRuleException, CHART_ESTIMATE_SCREEN_VALUE_LINE };
