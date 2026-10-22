import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildChartEstimateBlock } = require('../src/main/caption-pipeline/prompts/chart-estimate-block.js');
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');
const { createInterpretiveBridgeAgent } = require('../src/main/caption-pipeline/agents/interpretive-bridge-agent.js');

const okChart = ({ isSnapped = true, unit = '', labelList = ['2015', '2016', '2017', '2018', '2019'], valueList = [620, 680, 700, 740, 770], tickMax = 1000, step = 200 } = {}) => ({
  status: 'ok', skipReason: null, barCount: valueList.length, granularity: 10, isSnapped, unit, tickMin: 0, tickMax, step,
  tickValueList: [0, 200, 400, 600, 800, 1000],
  valueList: valueList.map((value, index) => ({ label: labelList ? labelList[index] : null, value, raw: value + 0.4 })),
});

test('블록(한국어): 눈금 범위·막대 수·범주별 "약" 값과 쓰는 법', () => {
  const { text, barCount } = buildChartEstimateBlock({ chart: okChart() });
  assert.equal(barCount, 5);
  assert.equal(text, [
    '참고: 그래프 어림값 — 화면의 세로 막대그래프를 시스템이 세로축 눈금(0~1,000, 200 간격)과 막대 높이로 잰 값이다. 화면에 적힌 숫자가 아니다.',
    '  막대 5개, 왼쪽부터: 2015 약 620 · 2016 약 680 · 2017 약 700 · 2018 약 740 · 2019 약 770',
    '  이 막대들의 값을 말할 때는 축 눈금 숫자가 아니라 이 어림값에 "약"을 붙여 쓴다. 발표자가 어림해 말한 수와 다르면 이 어림값을 쓴다.',
    '  화면에 그 막대의 값이 숫자로 적혀 있으면 적힌 값을 쓴다. 이미지의 그래프와 막대 수·순서가 맞지 않으면 이 값을 쓰지 않는다.',
  ].join('\n'));
});

test('블록: 범주 이름이 없으면 순서만, 단위는 값에 붙이고, 눈금선에 못 맞췄으면 오차 꼬리를 붙인다', () => {
  const unlabeled = buildChartEstimateBlock({ chart: okChart({ labelList: null }) }).text;
  assert.match(unlabeled, /막대 5개, 왼쪽부터: 약 620 · 약 680 · 약 700 · 약 740 · 약 770$/m);
  const percent = buildChartEstimateBlock({ chart: okChart({ unit: '%', valueList: [35, 48, 77], labelList: ['A', 'B', 'C'], tickMax: 100, step: 20 }) }).text;
  assert.match(percent, /A 약 35% · B 약 48% · C 약 77%/);
  assert.match(percent, /세로축 눈금\(0~100, 20 간격\)/);
  const won = buildChartEstimateBlock({ chart: okChart({ unit: '₩', valueList: [300, 450], labelList: null }) }).text;
  assert.match(won, /약 ₩300 · 약 ₩450/);
  const noGrid = buildChartEstimateBlock({ chart: okChart({ isSnapped: false }) }).text;
  assert.match(noGrid.split('\n')[0], /화면에 적힌 숫자가 아니다\. \(눈금선 없음, 오차가 더 클 수 있다\)$/);
});

test('블록(영어 캡션): 같은 내용을 영어로', () => {
  const { text } = buildChartEstimateBlock({ chart: okChart(), language: 'en' });
  assert.match(text, /^Note: chart estimates — the system measured the vertical bar chart on screen against its y-axis ticks \(0–1,000, step 200\) and bar heights; these numbers are not printed on screen\./);
  assert.match(text, /5 bars, left to right: 2015 about 620 · 2016 about 680 · 2017 about 700 · 2018 about 740 · 2019 about 770/);
  assert.match(text, /with "about", not an axis tick number/);
  assert.match(buildChartEstimateBlock({ chart: okChart({ isSnapped: false }), language: 'en' }).text, /\(no gridlines, the error may be larger\)/);
});

test('블록: 어림값이 없거나 건너뛰었으면 빈 덩어리', () => {
  for (const chart of [null, undefined, { status: 'skip', skipReason: 'value_labels' }, { status: 'ok', valueList: [] }]) {
    assert.deepEqual(buildChartEstimateBlock({ chart }), { text: '', barCount: 0 });
  }
});

const screenLineList = [{ text: '연도별 1인당 소비량', score: 0.97 }, { text: '1,000', score: 0.95 }, { text: '800', score: 0.95 }, { text: '2015 2016 2017 2018 2019', score: 0.95 }];

test('수치 프롬프트: 어림값이 없거나 건너뛰었으면 글자 하나까지 지금과 같다', () => {
  for (const subKind of ['claim_to_value', 'value_to_meaning', null]) {
    for (const language of ['ko', 'en']) {
      const base = { utterance: '소비량이 꾸준히 늘었습니다.', subKind, screenLineList, language, mergedClaimList: ['가격도 올랐고요'] };
      const before = buildInterpretationPrompt(base);
      assert.equal(buildInterpretationPrompt({ ...base, chartEstimate: null }), before, `${subKind} ${language}`);
      assert.equal(buildInterpretationPrompt({ ...base, chartEstimate: { status: 'skip', skipReason: 'value_labels' } }), before);
      assert.doesNotMatch(before, /그래프 어림값|chart estimates/);
    }
  }
});

test('수치 프롬프트: 어림값이 있으면 화면 글자 덩어리 바로 뒤에 블록을 넣고, 그때만 규칙 예외를 붙인다', () => {
  const prompt = buildInterpretationPrompt({ utterance: '소비량이 꾸준히 늘었습니다.', subKind: 'claim_to_value', screenLineList, chartEstimate: okChart() });
  const screenBlockEnd = prompt.indexOf('"""\n', prompt.indexOf('"""') + 3);
  const chartBlockStart = prompt.indexOf('참고: 그래프 어림값');
  assert.ok(screenBlockEnd >= 0 && chartBlockStart > screenBlockEnd, '화면 글자 덩어리 뒤');
  assert.ok(chartBlockStart < prompt.indexOf('청자는 화면을 볼 수 없다.'), '규칙 앞');
  assert.match(prompt, /않는다\.\n\n청자는 화면을 볼 수 없다\./, '블록 뒤 빈 줄 하나');
  assert.match(prompt, /\(1\) 화면에 실제로 보이는 값·문구만 쓴다\. \*\*추정하거나 지어내지 않는다\.\*\* 단, 위 「그래프 어림값」은 시스템이 잰 값이라 "약"을 붙여 쓸 수 있다\./);
  assert.match(prompt, /그래프 어림값이 있으면 그 값이 화면의 수치다\.\n\*\*화면에 수치가 없으면 "NONE"이다\.\*\*/);
  const valueToMeaning = buildInterpretationPrompt({ utterance: '770이라는 숫자가 중요합니다.', subKind: 'value_to_meaning', screenLineList, chartEstimate: okChart() });
  assert.match(valueToMeaning, /참고: 그래프 어림값/);
  assert.match(valueToMeaning, /단, 위 「그래프 어림값」은/);
  const english = buildInterpretationPrompt({ utterance: 'It kept rising.', subKind: 'claim_to_value', screenLineList, chartEstimate: okChart(), language: 'en' });
  assert.match(english, /Note: chart estimates/);
  assert.match(english, /단, 위 「그래프 어림값」은 시스템이 잰 값이라 "about"을 붙여 쓸 수 있다\./);
});

test('수치 에이전트: 어림값을 프롬프트로 넘기고 기록용 막대 수를 돌려준다(없으면 null)', async () => {
  const promptList = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    promptList.push(JSON.parse(init.body).messages.at(-1).content.find((part) => part.type === 'text').text);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"target":"1인당 소비량","value":"2015년 약 620에서 2019년 약 770"}' } }] }), { status: 200 });
  };
  try {
    const agent = createInterpretiveBridgeAgent({ config: { vlmUrl: 'http://vlm.test/v1/chat/completions', vlmModel: 'm' } });
    const withChart = await agent.generate({
      jpegBuffer: Buffer.from('x'), utterance: '소비량이 꾸준히 늘었습니다.', subKind: 'claim_to_value', screenLineList, chartEstimate: okChart(),
    });
    assert.deepEqual(withChart.chartBlock, { barCount: 5 });
    assert.match(promptList[0], /참고: 그래프 어림값/);
    const withoutChart = await agent.generate({ jpegBuffer: Buffer.from('x'), utterance: '소비량이 꾸준히 늘었습니다.', subKind: 'claim_to_value', screenLineList });
    assert.equal(withoutChart.chartBlock, null);
    assert.doesNotMatch(promptList[1], /그래프 어림값/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
