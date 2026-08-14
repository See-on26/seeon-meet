import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { drawBarChart, createCanvas, degrade, PALETTE } from './helpers/synthetic-chart.mjs';

const require = createRequire(import.meta.url);
const {
  parseTickNumber, findYAxis, computeGranularity, hasAxisCandidate, estimateChartValues, createChartEstimator,
  detectTickSnapSuspect, CHART_SKIP_REASON_MAP,
} = require('../src/main/caption-pipeline/perception/chart-value-estimator.js');

const estimate = (chart) => estimateChartValues({ bitmap: chart.bitmap, lineList: chart.lineList });

function assertOk(result, truthList, { maxError, label = '' } = {}) {
  assert.equal(result.status, 'ok', `${label} ${result.skipReason || ''}`);
  assert.equal(result.valueList.length, truthList.length, label);
  result.valueList.forEach((entry, index) => {
    assert.ok(Math.abs(entry.raw - truthList[index]) <= maxError, `${label} 막대 ${index}: ${entry.raw} vs ${truthList[index]}`);
    assert.ok(Math.abs(entry.value - truthList[index]) <= result.granularity, `${label} 반올림값 ${entry.value} vs ${truthList[index]}`);
  });
}

function assertSkip(result, skipReason, label = '') {
  assert.equal(result.status, 'skip', `${label} ok 로 나옴: ${JSON.stringify(result.valueList || [])}`);
  assert.equal(result.skipReason, skipReason, label);
}

// 순수 함수

test('눈금 글자: 쉼표·단위·부호·통화·소수를 읽고, 연도·날짜 꼴은 눈금으로 보지 않는다', () => {
  assert.deepEqual(parseTickNumber('1,000'), { value: 1000, unit: '' });
  assert.deepEqual(parseTickNumber('20%'), { value: 20, unit: '%' });
  assert.deepEqual(parseTickNumber('-5'), { value: -5, unit: '' });
  assert.deepEqual(parseTickNumber('−5'), { value: -5, unit: '' });
  assert.deepEqual(parseTickNumber('₩300'), { value: 300, unit: '₩' });
  assert.deepEqual(parseTickNumber('3.5만'), { value: 3.5, unit: '만' });
  assert.deepEqual(parseTickNumber(' 12 '), { value: 12, unit: '' });
  assert.equal(parseTickNumber('2019년'), null);
  assert.equal(parseTickNumber('3월'), null);
  assert.equal(parseTickNumber('2분기'), null);
  assert.equal(parseTickNumber('1위'), null);
  assert.equal(parseTickNumber('매출 182억'), null);
  assert.equal(parseTickNumber('2015 2016 2017'), null);
  assert.equal(parseTickNumber(''), null);
});

test('반올림 단위: 눈금 간격의 1/20 과 2화소 값 중 큰 쪽을 1·2·5 단위로', () => {
  assert.equal(computeGranularity({ step: 200, pixelValue: 1000 / 480 }), 10);
  assert.equal(computeGranularity({ step: 20, pixelValue: 100 / 480 }), 1);
  assert.equal(computeGranularity({ step: 2, pixelValue: 12 / 480 }), 0.1);
  assert.equal(computeGranularity({ step: 200, pixelValue: 1000 / 60 }), 20);
});

test('줄만 보는 사전 검사: 숫자 눈금이 세로로 3개 이상 고르게 있으면 참, 글만 있는 화면·표 숫자 열은 거짓', () => {
  assert.equal(hasAxisCandidate({ lineList: drawBarChart({ noise: false }).lineList }), true);
  assert.equal(hasAxisCandidate({ lineList: [{ text: '분기별 성과 요약', score: 0.95, left: 100, top: 50, width: 300, height: 30 }, { text: '매출 182억', score: 0.95, left: 100, top: 120, width: 200, height: 24 }] }), false);
  const tableColumn = [950, 720, 410, 300, 120].map((value, index) => ({ text: String(value), score: 0.95, left: 600, top: 150 + index * 60, width: 40, height: 20 }));
  assert.equal(hasAxisCandidate({ lineList: tableColumn }), false);
  assert.equal(hasAxisCandidate({ lineList: [] }), false);
});

test('세로축 찾기: 눈금 하나를 잘못 읽어도("400"→"40") 그 눈금을 빼고 맞춘다', () => {
  const { lineList } = drawBarChart({ noise: false, misreadTickMap: { 400: '40' } });
  const { axis } = findYAxis({ lineList, width: 1280 });
  assert.ok(axis);
  assert.equal(axis.tickList.length, 5);
  assert.ok(!axis.tickList.some((tick) => tick.value === 40));
});

// 맞혀야 하는 그래프

test('0~1,000 축 5막대: 범주 이름을 붙이고 원래 값과 2 안으로 맞힌다("2019 약 770")', () => {
  const result = estimate(drawBarChart());
  assertOk(result, [620, 680, 700, 740, 770], { maxError: 2 });
  assert.deepEqual(result.valueList.map((entry) => entry.label), ['2015', '2016', '2017', '2018', '2019']);
  assert.equal(result.valueList[4].value, 770);
  assert.equal(result.granularity, 10);
  assert.equal(result.isSnapped, true);
  assert.deepEqual({ min: result.tickMin, max: result.tickMax, step: result.step }, { min: 0, max: 1000, step: 200 });
  assert.equal(result.unit, '');
  assert.deepEqual(result.tickValueList, [0, 200, 400, 600, 800, 1000]);
});

test('여러 축: 0~100%(단위), 0~12(소수), 0이 아닌 시작(600~800)', () => {
  const percent = estimate(drawBarChart({ axis: { min: 0, max: 100, step: 20 }, tickUnit: '%', valueList: [35, 48, 52, 77] }));
  assertOk(percent, [35, 48, 52, 77], { maxError: 1, label: '%' });
  assert.equal(percent.unit, '%');
  const decimal = estimate(drawBarChart({ axis: { min: 0, max: 12, step: 2 }, valueList: [3.4, 7.3, 9.8, 11.2, 5.5, 6.1] }));
  assertOk(decimal, [3.4, 7.3, 9.8, 11.2, 5.5, 6.1], { maxError: 0.15, label: '소수' });
  assert.equal(decimal.granularity, 0.1);
  const offset = estimate(drawBarChart({ axis: { min: 600, max: 800, step: 50 }, valueList: [640, 705, 760] }));
  assertOk(offset, [640, 705, 760], { maxError: 2, label: '600~800' });
});

test('강조색 막대 하나·옅은 막대·범례 네모·막대 안 흰 글자도 맞힌다', () => {
  const truthList = [620, 680, 700, 740, 770];
  assertOk(estimate(drawBarChart({ colorList: [PALETTE.blue, PALETTE.blue, PALETTE.blue, PALETTE.blue, PALETTE.red] })), truthList, { maxError: 2, label: '강조' });
  assertOk(estimate(drawBarChart({ pale: true })), truthList, { maxError: 2, label: '옅음' });
  assertOk(estimate(drawBarChart({ legend: true })), truthList, { maxError: 2, label: '범례' });
  assertOk(estimate(drawBarChart({ insideText: true })), truthList, { maxError: 2, label: '안 글자' });
  assertOk(estimate(drawBarChart({ misreadTickMap: { 400: '40' } })), truthList, { maxError: 2, label: '눈금 오독' });
});

test('범주 이름 줄이 없으면 이름 없이 왼쪽부터 순서로 낸다', () => {
  const result = estimate(drawBarChart({ categoryLine: false }));
  assertOk(result, [620, 680, 700, 740, 770], { maxError: 2 });
  assert.deepEqual(result.valueList.map((entry) => entry.label), [null, null, null, null, null]);
});

test('눈금선이 없고 OCR 상자가 ±4px 흔들려도 오차는 축 범위의 1% 안이다(눈금선 맞춤 없음 표시)', () => {
  for (const seed of [3, 5, 9, 13]) {
    const result = estimate(drawBarChart({ gridlines: false, ocrJitterPx: 4, seed, valueList: [310, 455, 820, 640, 905] }));
    assertOk(result, [310, 455, 820, 640, 905], { maxError: 10, label: `씨앗 ${seed}` });
    assert.equal(result.isSnapped, false);
  }
});

test('1920 렌더를 1280 으로 줄인 듯한 작은 그래프(그림 영역 절반)도 맞힌다', () => {
  const result = estimate(drawBarChart({ plot: { left: 160, right: 620, top: 300, bottom: 560 }, valueList: [120, 340, 560, 780] }));
  assertOk(result, [120, 340, 560, 780], { maxError: 5 });
});

// 건너뛰어야 하는 그래프

test('값 라벨이 있으면(위·안·일부만) 건너뛴다', () => {
  for (const valueLabels of ['above', 'inside', 'partial']) {
    assertSkip(estimate(drawBarChart({ valueLabels })), CHART_SKIP_REASON_MAP.valueLabels, valueLabels);
  }
});

test('누적·그라데이션은 non_uniform_bar, 묶음 2계열은 uneven_spacing', () => {
  assertSkip(estimate(drawBarChart({ stacked: true })), CHART_SKIP_REASON_MAP.nonUniformBar, '누적');
  assertSkip(estimate(drawBarChart({ gradient: true })), CHART_SKIP_REASON_MAP.nonUniformBar, '그라데이션');
  const grouped = drawBarChart({
    valueList: [620, 500, 680, 520, 700, 560, 740, 600], colorList: [PALETTE.blue, PALETTE.orange], groupSize: 2,
  });
  assertSkip(estimate(grouped), CHART_SKIP_REASON_MAP.unevenSpacing, '묶음');
});

test('로그 축은 no_axis', () => {
  const canvas = createCanvas({ width: 1280, height: 720 });
  const lineList = [1, 10, 100, 1000].map((value, index) => {
    const y = 600 - index * 160;
    for (let x = 200; x < 980; x += 1) canvas.blend(x, y, [225, 225, 225]);
    return { text: String(value), score: 0.95, left: 150, top: y - 10, width: 38, height: 20 };
  });
  [300, 600, 900].forEach((height, index) => canvas.fillRect(260 + index * 260 - 40, 600 - height * 0.48, 260 + index * 260 + 40, 600, PALETTE.blue));
  assertSkip(estimateChartValues({ bitmap: canvas.bitmap, lineList }), CHART_SKIP_REASON_MAP.noAxis);
});

test('이중 축·한 화면에 그래프 둘은 multiple_axes', () => {
  // 오른쪽 축 눈금(0~100%, 25 간격). 같은 높이의 "0" 과 "0%" 는 서버 OCR 이 한 줄로 잇는다.
  const dual = drawBarChart();
  const zeroLine = dual.lineList.find((line) => line.text === '0');
  Object.assign(zeroLine, { text: '0 0%', width: 1040 - zeroLine.left });
  [25, 50, 75, 100].forEach((value) => {
    const y = 600 - value * 4.8;
    dual.lineList.push({ text: `${value}%`, score: 0.95, left: 1000, top: Math.round(y - 10), width: 40, height: 20 });
  });
  assertSkip(estimateChartValues({ bitmap: dual.bitmap, lineList: dual.lineList }), CHART_SKIP_REASON_MAP.multipleAxes, '이중 축');
  // 높이가 다른 그래프 둘(눈금 줄이 서로 이어지지 않는 높이).
  const left = drawBarChart({ noise: false, plot: { left: 100, right: 560, top: 140, bottom: 560 }, titleLine: false });
  const right = drawBarChart({
    noise: false, plot: { left: 760, right: 1220, top: 180, bottom: 520 }, titleLine: false,
    axis: { min: 0, max: 600, step: 150 }, valueList: [300, 500, 400], categoryList: ['A', 'B', 'C'],
  });
  const merged = left.bitmap;
  for (let y = 0; y < 720; y += 1) {
    for (let x = 660; x < 1280; x += 1) {
      const i = (y * 1280 + x) * 4;
      for (let k = 0; k < 3; k += 1) merged.data[i + k] = right.bitmap.data[i + k];
    }
  }
  assertSkip(estimateChartValues({ bitmap: degrade(merged), lineList: [...left.lineList, ...right.lineList] }), CHART_SKIP_REASON_MAP.multipleAxes, '그래프 둘');
});

test('범주 낱말 수가 막대 수와 다르면 category_mismatch("20대 남성" 처럼 띄어 쓴 이름)', () => {
  const chart = drawBarChart({ valueList: [620, 680, 700], categoryList: ['20대 남성', '30대 남성', '40대 남성'] });
  assertSkip(estimate(chart), CHART_SKIP_REASON_MAP.categoryMismatch);
});

test('표의 숫자 열·연도 열 표·글만 있는 화면은 어림하지 않는다', () => {
  const blank = createCanvas({ width: 1280, height: 720 });
  const tableColumn = [950, 720, 410, 300, 120].map((value, index) => ({ text: String(value), score: 0.95, left: 600, top: 150 + index * 60, width: 40, height: 20 }));
  assertSkip(estimateChartValues({ bitmap: blank.bitmap, lineList: tableColumn }), CHART_SKIP_REASON_MAP.noAxis, '숫자 열');
  const yearTable = createCanvas({ width: 1280, height: 720 });
  const yearLineList = [2023, 2022, 2021, 2020].map((value, index) => ({ text: String(value), score: 0.95, left: 100, top: 150 + index * 60, width: 50, height: 20 }));
  for (let row = 0; row < 4; row += 1) yearTable.fillRect(200, 145 + row * 60, 900, 175 + row * 60, row % 2 ? [240, 240, 240] : [200, 220, 240]);
  assert.equal(estimateChartValues({ bitmap: yearTable.bitmap, lineList: yearLineList }).status, 'skip', '연도 열 표');
  const textOnly = [{ text: '분기별 성과 요약', score: 0.95, left: 100, top: 50, width: 300, height: 30 }];
  assertSkip(estimateChartValues({ bitmap: blank.bitmap, lineList: textOnly }), CHART_SKIP_REASON_MAP.noAxis, '글만');
});

test('막대 1개·25개는 bar_count', () => {
  assertSkip(estimate(drawBarChart({ valueList: [640], categoryList: ['2019'] })), CHART_SKIP_REASON_MAP.barCount, '1개');
  const many = Array.from({ length: 25 }, (_, index) => 300 + ((index * 37) % 500));
  assertSkip(estimate(drawBarChart({ valueList: many, categoryLine: false, plot: { left: 100, right: 1250, top: 120, bottom: 600 }, barRatio: 0.6 })), CHART_SKIP_REASON_MAP.barCount, '25개');
});

test('눈금 점수가 0.85 아래면 눈금으로 보지 않는다(no_axis)', () => {
  assertSkip(estimate(drawBarChart({ tickScore: 0.8 })), CHART_SKIP_REASON_MAP.noAxis);
});

test('바닥선 아래로 내려간 막대(음수)가 섞이면 off_baseline_bar 로 건너뛴다', () => {
  const chart = drawBarChart({ axis: { min: -400, max: 1000, step: 200 }, baseValue: 0, valueList: [620, -150, 700, 740, 770] });
  assertSkip(estimate(chart), CHART_SKIP_REASON_MAP.offBaselineBar);
});

test('눈금 "600" 줄이 오른쪽 글과 한 줄로 이어지면 놓치더라도 ok 로 내지 않는다', () => {
  const chart = drawBarChart({ misreadTickMap: { 600: '600 출처 통계청' } });
  const merged = chart.lineList.find((line) => line.text.startsWith('600 '));
  merged.width = 1150 - merged.left;
  assert.equal(estimate(chart).status, 'skip');
});

// 실행기(디코더·시간·사전 검사)

test('실행기: 축 후보가 없으면 그림을 풀지 않고 no_axis', () => {
  let decodeCount = 0;
  const estimator = createChartEstimator({ decoder: { decode: () => { decodeCount += 1; return null; } } });
  const result = estimator.estimate({ jpegBuffer: Buffer.from('x'), lineList: [{ text: '제목', score: 0.95, left: 0, top: 0, width: 10, height: 10 }] });
  assert.equal(result.status, 'skip');
  assert.equal(result.skipReason, 'no_axis');
  assert.equal(result.decodeMs, null);
  assert.equal(result.isDecoded, false);
  assert.equal(decodeCount, 0);
});

test('실행기: 디코더가 없으면 no_decoder, 풀기 실패면 decode_error', () => {
  const { lineList, bitmap } = drawBarChart();
  assert.equal(createChartEstimator({ decoder: null }).estimate({ jpegBuffer: Buffer.from('x'), lineList }).skipReason, 'no_decoder');
  const failed = createChartEstimator({ decoder: { decode: () => null } }).estimate({ jpegBuffer: Buffer.from('x'), lineList });
  assert.equal(failed.skipReason, 'decode_error');
  assert.equal(failed.isDecoded, false);
  const ok = createChartEstimator({ decoder: { decode: () => bitmap } }).estimate({ jpegBuffer: Buffer.from('x'), lineList });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.isDecoded, true);
  assert.ok(Number.isFinite(ok.decodeMs) && Number.isFinite(ok.estimateMs));
  assert.deepEqual({ width: ok.imageWidth, height: ok.imageHeight }, { width: 1280, height: 720 });
});

// 진단: 값 칸 숫자가 눈금 값과 같고 모든 어림값과 한 단위 넘게 다르면 "눈금으로 반올림한 값" 의심

test('눈금값 의심: "약 800" 은 의심, "약 770"·어림값이 없는 그래프·눈금에 없는 수는 의심 아님', () => {
  const chart = estimate(drawBarChart());
  assert.equal(detectTickSnapSuspect({ value: '2019년 약 800', chart }), true);
  assert.equal(detectTickSnapSuspect({ value: '2019년 약 770', chart }), false);
  assert.equal(detectTickSnapSuspect({ value: '약 650', chart }), false);
  assert.equal(detectTickSnapSuspect({ value: '약 800', chart: { status: 'skip', skipReason: 'value_labels' } }), false);
  assert.equal(detectTickSnapSuspect({ value: '약 800', chart: null }), false);
});
