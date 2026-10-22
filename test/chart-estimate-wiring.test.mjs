import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { drawBarChart } from './helpers/synthetic-chart.mjs';

const require = createRequire(import.meta.url);
const {
  readPipelineConfig, CHART_ESTIMATE_MODE_LIST, DEFAULT_CHART_ESTIMATE_MODE,
} = require('../src/main/caption-pipeline/config.js');
const {
  createScreenTextGrounding, finalizeScreenTextRecord, formatScreenTextSummary,
} = require('../src/main/caption-pipeline/orchestrator/screen-text-grounding.js');
const { createChartEstimator, estimateChartValues, toChartValueList } = require('../src/main/caption-pipeline/perception/chart-value-estimator.js');
const {
  createFrameDecoder, resolveNativeImage, createChartFrameSaver, buildChartFrameTag,
} = require('../src/main/caption-pipeline/perception/frame-bitmap.js');
const {
  verifyValuePresence, markApproximateNumber, hasUnmarkedApproximateNumber, approximateChartNarration, VALUE_CHECK_SOURCE_MAP,
} = require('../src/main/caption-pipeline/orchestrator/value-presence.js');

afterEach(() => { mock.restoreAll(); });

// 설정

test('설정: SEEON_CHART_ESTIMATE 는 off(기본)·log·on, 모르는 값은 한 번 경고하고 off', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.deepEqual(CHART_ESTIMATE_MODE_LIST, ['off', 'log', 'on']);
  assert.equal(DEFAULT_CHART_ESTIMATE_MODE, 'off');
  assert.equal(readPipelineConfig({}).chartEstimateMode, 'off');
  assert.equal(readPipelineConfig({ SEEON_CHART_ESTIMATE: '' }).chartEstimateMode, 'off');
  assert.equal(readPipelineConfig({ SEEON_CHART_ESTIMATE: 'log' }).chartEstimateMode, 'log');
  assert.equal(readPipelineConfig({ SEEON_CHART_ESTIMATE: 'on' }).chartEstimateMode, 'on');
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(readPipelineConfig({ SEEON_CHART_ESTIMATE: 'true' }).chartEstimateMode, 'off');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /SEEON_CHART_ESTIMATE/);
});

// 근거 OCR 작업에 붙은 그래프 어림

const chart = drawBarChart();
const ocrResult = { text: '', lineList: chart.lineList, meanScore: 0.95, verticalBoxRatio: 0, imageWidth: 1280, imageHeight: 720 };
const jpegBuffer = Buffer.from('frame');

function countingEstimator(behavior = () => ({ status: 'ok', valueList: [] })) {
  const callList = [];
  return { callList, estimate: (args) => { callList.push(args); return behavior(args); } };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

test('수치 해설이 아니면(withChart 없음) 어림하지 않고 기록·결과에 그래프 칸이 없다', async () => {
  const estimator = countingEstimator();
  const task = createScreenTextGrounding({ ocrClient: { recognize: async () => ocrResult }, chartEstimator: estimator }).start({ jpegBuffer });
  const result = await task.waitForPrompt();
  assert.equal(estimator.callList.length, 0);
  assert.equal(result.chart, null);
  assert.equal('chart' in result.record, false);
});

test('어림기가 없으면(off) withChart 여도 어림하지 않는다', async () => {
  const task = createScreenTextGrounding({ ocrClient: { recognize: async () => ocrResult } }).start({ jpegBuffer });
  const result = await task.waitForPrompt({ withChart: true });
  assert.equal(result.chart, null);
  assert.equal('chart' in result.record, false);
});

test('수치 해설이면 같은 프레임과 OCR 줄로 한 번만 어림하고, 기록에 요약을 남긴다', async () => {
  const estimator = createChartEstimator({ decoder: { decode: () => chart.bitmap } });
  const spy = { count: 0 };
  const chartEstimator = { estimate: (args) => { spy.count += 1; spy.args = args; return estimator.estimate(args); } };
  const task = createScreenTextGrounding({ ocrClient: { recognize: async () => ocrResult }, chartEstimator }).start({ jpegBuffer });
  const first = await task.waitForPrompt({ withChart: true, frameTag: '1700000000000-12.50s' });
  const second = await task.waitForPrompt({ withChart: true, frameTag: '1700000000000-12.50s' });
  assert.equal(spy.count, 1, '같은 작업에서 두 번 불러도 한 번만');
  assert.equal(spy.args.jpegBuffer, jpegBuffer);
  assert.equal(spy.args.lineList.length, chart.lineList.length);
  assert.equal(spy.args.frameTag, '1700000000000-12.50s');
  assert.equal(first.chart, second.chart);
  assert.equal(first.chart.status, 'ok');
  assert.equal(first.lineList.length, chart.lineList.length, '줄은 그대로');
  const { chart: chartRecord } = first.record;
  assert.equal(chartRecord.status, 'ok');
  assert.equal(chartRecord.frameTag, '1700000000000-12.50s', '어느 순간의 화면인지(요청 시각-영상 시각)');
  assert.equal(chartRecord.barCount, 5);
  assert.equal(chartRecord.isSnapped, true);
  assert.equal(chartRecord.granularity, 10);
  assert.deepEqual(chartRecord.valueList.map((entry) => [entry.label, entry.value]), [['2015', 620], ['2016', 680], ['2017', 700], ['2018', 740], ['2019', 770]]);
  assert.ok(chartRecord.valueList.every((entry) => Number.isFinite(entry.raw)));
  assert.ok(Number.isFinite(chartRecord.decodeMs) && Number.isFinite(chartRecord.estimateMs));
  assert.deepEqual([chartRecord.imageWidth, chartRecord.imageHeight], [1280, 720]);
});

test('OCR 이 상한 안에 끝나지 않거나 쓸 수 없으면 어림값 없이 ocr_unusable', async () => {
  const pending = deferred();
  const estimator = countingEstimator();
  const lateTask = createScreenTextGrounding({ ocrClient: { recognize: () => pending.promise }, chartEstimator: estimator, waitMs: 10 }).start({ jpegBuffer });
  const late = await lateTask.waitForPrompt({ withChart: true });
  assert.equal(late.chart.status, 'skip');
  assert.equal(late.chart.skipReason, 'ocr_unusable');
  assert.equal(late.record.chart.skipReason, 'ocr_unusable');
  assert.equal(late.record.skipReason, 'ocr_late');
  pending.resolve(ocrResult);
  const lowTask = createScreenTextGrounding({
    ocrClient: { recognize: async () => ({ ...ocrResult, meanScore: 0.5 }) }, chartEstimator: estimator,
  }).start({ jpegBuffer });
  assert.equal((await lowTask.waitForPrompt({ withChart: true })).chart.skipReason, 'ocr_unusable');
  assert.equal(estimator.callList.length, 0);
});

test('디코더가 없으면 no_decoder, 어림기가 예외를 던져도 줄은 그대로 돌려주고 error 로 남긴다', async () => {
  const noDecoder = createScreenTextGrounding({
    ocrClient: { recognize: async () => ocrResult }, chartEstimator: createChartEstimator({ decoder: null }),
  }).start({ jpegBuffer });
  assert.equal((await noDecoder.waitForPrompt({ withChart: true })).chart.skipReason, 'no_decoder');
  const throwing = createScreenTextGrounding({
    ocrClient: { recognize: async () => ocrResult }, chartEstimator: { estimate: () => { throw new Error('boom'); } },
  }).start({ jpegBuffer });
  const result = await throwing.waitForPrompt({ withChart: true });
  assert.equal(result.lineList.length, chart.lineList.length);
  assert.equal(result.record.source, 'fresh');
  assert.equal(result.chart.status, 'skip');
  assert.equal(result.chart.skipReason, 'error');
  assert.equal(result.record.chart.errorMessage, 'boom');
});

test('기록 요약: 프롬프트에 넣었는지 붙이고, 흐름 창 한 줄에 그래프 어림을 덧붙인다', () => {
  const okRecord = {
    source: 'fresh', totalLineCount: 9, meanScore: 0.94, ocrMs: 480, waitedMs: 0, skipReason: null,
    chart: {
      status: 'ok', skipReason: null, barCount: 2, isSnapped: true, granularity: 10, decodeMs: 8.2, estimateMs: 5.1,
      valueList: [{ label: '2015', value: 620, raw: 620.8 }, { label: '2019', value: 770, raw: 770.8 }], unit: '',
    },
  };
  const logged = finalizeScreenTextRecord({ record: okRecord, screenTextBlock: { lineCount: 9, charCount: 120 } });
  assert.equal(logged.chart.isInPrompt, false);
  const prompted = finalizeScreenTextRecord({ record: okRecord, screenTextBlock: { lineCount: 9, charCount: 120 }, chartBlock: { barCount: 5 } });
  assert.equal(prompted.chart.isInPrompt, true);
  assert.equal(okRecord.chart.isInPrompt, undefined, '원래 기록은 바꾸지 않는다');
  assert.equal(
    formatScreenTextSummary(logged),
    '화면 글자=같은 프레임 OCR 9/9줄 120자 점수 0.94 OCR 480ms 대기 0ms · 그래프 어림=ok 막대2 [2015 약 620 · 2019 약 770] 눈금선 풀기 8.2ms 분석 5.1ms 기록만',
  );
  assert.match(formatScreenTextSummary(prompted), /그래프 어림=ok 막대2 .* 프롬프트 넣음$/);
  const skipped = finalizeScreenTextRecord({ record: { ...okRecord, chart: { status: 'skip', skipReason: 'value_labels', barCount: 5, decodeMs: 7, estimateMs: 3 } } });
  assert.match(formatScreenTextSummary(skipped), / · 그래프 어림=건너뜀\(value_labels\)$/);
  const late = { source: 'none', totalLineCount: 0, meanScore: null, ocrMs: null, waitedMs: 1001, skipReason: 'ocr_late', chart: { status: 'skip', skipReason: 'ocr_unusable' } };
  assert.equal(formatScreenTextSummary(finalizeScreenTextRecord({ record: late })), '화면 글자=없음(ocr_late, 대기 1001ms) · 그래프 어림=건너뜀(ocr_unusable)');
  const noChart = finalizeScreenTextRecord({ record: { ...okRecord, chart: undefined } });
  assert.equal('chart' in noChart && noChart.chart !== undefined, false);
});

// 디코더·프레임 저장

test('디코더: nativeImage 로 JPEG 을 풀어 화소를 돌려주고, 비었거나 크기가 맞지 않으면 null', () => {
  const bitmapData = Buffer.alloc(4 * 3 * 2, 7);
  const makeImage = ({ isEmpty = false, size = { width: 3, height: 2 }, data = bitmapData } = {}) => ({
    isEmpty: () => isEmpty, getSize: () => size, toBitmap: () => data,
  });
  const received = [];
  const decoder = createFrameDecoder({ nativeImage: { createFromBuffer: (buffer) => { received.push(buffer); return makeImage(); } } });
  const bitmap = decoder.decode(Buffer.from('jpeg'));
  assert.deepEqual({ width: bitmap.width, height: bitmap.height, length: bitmap.data.length }, { width: 3, height: 2, length: 24 });
  assert.ok(Buffer.isBuffer(received[0]));
  assert.equal(createFrameDecoder({ nativeImage: { createFromBuffer: () => makeImage({ isEmpty: true }) } }).decode(Buffer.from('x')), null);
  assert.equal(createFrameDecoder({ nativeImage: { createFromBuffer: () => makeImage({ data: Buffer.alloc(5) }) } }).decode(Buffer.from('x')), null);
  assert.equal(createFrameDecoder({ nativeImage: null }), null);
});

test('Electron 밖(node 시험·공장 shim)에서는 nativeImage 가 없어 디코더도 없다', () => {
  assert.equal(resolveNativeImage(), null);
});

test('프레임 저장: 어림에 쓴 그림을 요청 시각 이름으로 남기고 경로를 돌려준다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-frames-'));
  const saver = createChartFrameSaver({ dir: path.join(dir, 'chart-frames') });
  const frameTag = buildChartFrameTag({ ts: 1700000000123, videoTimeMs: 754321 });
  assert.equal(frameTag, '1700000000123-754.32s');
  assert.equal(buildChartFrameTag({ ts: 1700000000123, videoTimeMs: null }), '1700000000123');
  const filePath = saver.save({ jpegBuffer: Buffer.from('jpeg-bytes'), frameTag });
  assert.equal(filePath, path.join(dir, 'chart-frames', '1700000000123-754.32s.jpg'));
  await saver.flush();
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'jpeg-bytes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('실행기: 그림을 풀어 어림했을 때만 프레임을 저장하고 그 경로를 결과에 남긴다', () => {
  const saved = [];
  const saveFrame = ({ jpegBuffer: buffer, frameTag }) => { saved.push({ buffer, frameTag }); return `/out/chart-frames/${frameTag}.jpg`; };
  const estimator = createChartEstimator({ decoder: { decode: () => chart.bitmap }, saveFrame });
  const result = estimator.estimate({ jpegBuffer, lineList: chart.lineList, frameTag: 'tag' });
  assert.equal(result.framePath, '/out/chart-frames/tag.jpg');
  assert.equal(saved.length, 1);
  const noAxis = estimator.estimate({ jpegBuffer, lineList: [{ text: '제목', score: 0.9, left: 0, top: 0, width: 10, height: 10 }], frameTag: 'tag2' });
  assert.equal(noAxis.framePath, undefined);
  assert.equal(saved.length, 1);
});

// 값 검사 면제

const okChart = estimateChartValues({ bitmap: chart.bitmap, lineList: chart.lineList });
const chartValueList = toChartValueList(okChart);
const frameText = chart.lineList.map((line) => line.text).join('\n');

function countingRetranscribe(result = { text: '', hasText: false }) {
  const counter = { count: 0 };
  counter.retranscribe = async () => { counter.count += 1; return result; };
  return counter;
}

test('값 검사: 화면에 없는 숫자가 모두 어림값과 반올림 단위 안이면 present(chart_estimate), 재전사하지 않는다', async () => {
  const counter = countingRetranscribe();
  const verdict = await verifyValuePresence({
    value: '2015년 약 620에서 2019년 약 770', subKind: 'claim_to_value', frameText, slideTextStatus: 'pending',
    retranscribe: counter.retranscribe, chartValueList,
  });
  assert.equal(verdict.verdict, 'present');
  assert.equal(verdict.checkedSource, VALUE_CHECK_SOURCE_MAP.chartEstimate);
  assert.equal(verdict.checkedSource, 'chart_estimate');
  assert.deepEqual(verdict.chartCoreList, ['620', '770']);
  assert.equal(verdict.isRetranscribed, false);
  assert.equal(counter.count, 0);
});

test('값 검사: 단위 밖 숫자가 하나라도 있으면 지금처럼 재전사로 확인하고, 어림값이 없으면 면제하지 않는다', async () => {
  const outside = countingRetranscribe({ text: frameText, hasText: true });
  const verdict = await verifyValuePresence({
    value: '2015년 약 620에서 2019년 약 790', subKind: 'claim_to_value', frameText, slideTextStatus: 'pending',
    retranscribe: outside.retranscribe, chartValueList,
  });
  assert.equal(outside.count, 1);
  assert.equal(verdict.verdict, 'absent');
  assert.equal(verdict.checkedSource, 'frame_ocr');
  const noChart = countingRetranscribe({ text: frameText, hasText: true });
  const plain = await verifyValuePresence({
    value: '약 770', subKind: 'claim_to_value', frameText, slideTextStatus: 'pending', retranscribe: noChart.retranscribe,
  });
  assert.equal(noChart.count, 1);
  assert.equal(plain.verdict, 'absent');
});

test('값 검사: 눈금 값("약 800")은 화면에 적혀 있어 지금처럼 OCR 로 present', async () => {
  const counter = countingRetranscribe();
  const verdict = await verifyValuePresence({
    value: '2019년 약 800', subKind: 'claim_to_value', frameText, slideTextStatus: 'pending', retranscribe: counter.retranscribe, chartValueList,
  });
  assert.equal(verdict.verdict, 'present');
  assert.equal(verdict.checkedSource, 'frame_ocr');
  assert.equal(verdict.chartCoreList, undefined);
});

test('어림 표지: 어림값으로 통과한 숫자 앞에만 "약"(영어 about)을 붙이고, 이미 붙은 숫자는 그대로 둔다', () => {
  assert.equal(markApproximateNumber({ text: '2015년 620에서 2019년 770', coreList: ['620', '770'] }), '2015년 약 620에서 2019년 약 770');
  assert.equal(markApproximateNumber({ text: '2015년 약 620에서 2019년 770쯤', coreList: ['620', '770'] }), '2015년 약 620에서 2019년 770쯤');
  assert.equal(markApproximateNumber({ text: '1,000명', coreList: ['1000'] }), '약 1,000명');
  assert.equal(markApproximateNumber({ text: '620 in 2015 to 770 in 2019', coreList: ['620', '770'], language: 'en' }), 'about 620 in 2015 to about 770 in 2019');
  assert.equal(hasUnmarkedApproximateNumber({ text: '1인당 소비량, 2015년 약 620에서 2019년 약 770', coreList: ['620', '770'] }), false);
  assert.equal(hasUnmarkedApproximateNumber({ text: '1인당 소비량, 2015년 약 620에서 2019년 770', coreList: ['620', '770'] }), true);
  assert.equal(hasUnmarkedApproximateNumber({ text: '770 정도', coreList: ['770'] }), false);
});

test('어림 다시 조립: 값 칸에 "약"을 붙여 다시 조립하고, 붙일 수 없으면 null(해설을 버림)', () => {
  const claim = approximateChartNarration({
    narrationType: 'interpretation', subKind: 'claim_to_value', slotMap: { target: '1인당 소비량', value: '2015년 620에서 2019년 770' },
    coreList: ['620', '770'],
  });
  assert.equal(claim.text, '1인당 소비량, 2015년 약 620에서 2019년 약 770');
  const meaning = approximateChartNarration({
    narrationType: 'interpretation', subKind: 'value_to_meaning', slotMap: { value: '770', frame: '2019년 1인당 소비량' }, coreList: ['770'],
  });
  assert.equal(meaning.text, '약 770은 2019년 1인당 소비량을 의미');
  const english = approximateChartNarration({
    narrationType: 'interpretation', subKind: 'claim_to_value', slotMap: { target: 'per-capita use', value: '620 in 2015 to 770 in 2019' },
    coreList: ['620', '770'], language: 'en',
  });
  assert.equal(english.text, 'Per-capita use, about 620 in 2015 to about 770 in 2019');
  const tooLong = approximateChartNarration({
    narrationType: 'interpretation', subKind: 'value_to_meaning', slotMap: { value: '2019년 770', frame: '1인당 소비량' }, coreList: ['770'],
  });
  assert.equal(tooLong, null, '값 칸 상한에서 "약" 뒤 숫자가 잘리면 어림을 사실처럼 말하게 되므로 버린다');
});

// main 배선

const readPipelineSource = () => fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');

test('main: 꺼져 있으면 어림기를 만들지 않고, 켜져 있으면 nativeImage 디코더와 프레임 저장을 넣어 근거 OCR 에 붙인다', () => {
  const source = readPipelineSource();
  assert.match(source, /const chartEstimator = config\.chartEstimateMode === CHART_ESTIMATE_MODE_MAP\.off \? null : createChartEstimator\(\{/);
  assert.match(source, /decoder: createFrameDecoder\(\{ nativeImage: resolveNativeImage\(\) \}\)/);
  assert.match(source, /saveFrame: createChartFrameSaver\(\{ dir: CHART_FRAMES_DIR \}\)\.save/);
  assert.match(source, /createScreenTextGrounding\(\{\s*ocrClient, isEnabled: \(\) => config\.isScreenTextGroundingEnabled, chartEstimator,\s*\}\)/);
});

test('main: 수치 해설일 때만 어림을 기다리고, 프롬프트·값 검사에는 on 일 때만 넘긴다(log 는 기록만)', () => {
  const source = readPipelineSource();
  assert.match(source, /const screenTextPromise = isScreenTextNarrationType\(narrationType\) && screenTextTask\s*\? screenTextTask\.waitForPrompt\(\{\s*withChart: narrationType === NARRATION_TYPE_MAP\.interpretation,\s*frameTag: buildChartFrameTag\(\{ ts, videoTimeMs: eventVideoTimeMs \}\),\s*\}\)\s*: null;/);
  assert.match(source, /const screenText = screenTextPromise \? await screenTextPromise : null;/);
  assert.match(source, /const isChartEstimateInPrompt = config\.chartEstimateMode === CHART_ESTIMATE_MODE_MAP\.on;/);
  assert.match(source, /const chartEstimate = isChartEstimateInPrompt && screenText\?\.chart\?\.status === CHART_STATUS_MAP\.ok \? screenText\.chart : null;/);
  const interpretationArg = source.match(/\[NARRATION_TYPE_MAP\.interpretation\]: \{[^}]*\}/)[0];
  assert.match(interpretationArg, /chartEstimate/);
  const visualArg = source.match(/\[NARRATION_TYPE_MAP\.visualDescription\]: \{[^}]*\}/)[0];
  assert.doesNotMatch(visualArg, /chart/, '척도 에이전트에는 넘기지 않는다');
  assert.match(source, /chartValueList: toChartValueList\(chartEstimate\)/);
  assert.match(source, /finalizeScreenTextRecord\(\{ record: screenText\.record, screenTextBlock, chartBlock \}\)/);
  assert.match(source, /detectTickSnapSuspect\(\{ value: slotMap\.value, chart: screenText\?\.chart \}\)/);
});

// 흐름 창은 생성 기록 detail 의 → "문장" (Nms …) 에서 해설 문장과 걸린 시간을 읽는다. 그래프 어림 요약이 붙어도 그대로 읽어야 한다.
test('흐름 창: 화면 글자 요약 뒤에 그래프 어림 요약이 붙어도 해설 문장과 시간을 그대로 읽는다', () => {
  const { buildFlowList } = require('../src/main/dev-flow/flow-builder.js');
  const summary = formatScreenTextSummary({
    source: 'fresh', totalLineCount: 9, lineCount: 9, charCount: 120, meanScore: 0.95, ocrMs: 410, waitedMs: 0, skipReason: null,
    chart: {
      status: 'ok', barCount: 2, isSnapped: false, decodeMs: 1.6, estimateMs: 4.9, unit: '%', isInPrompt: true,
      valueList: [{ label: '2015', value: 62, raw: 62.1 }, { label: '2019', value: 77, raw: 77.2 }],
    },
  });
  assert.match(summary, /그래프 어림=ok 막대2 \[2015 약 62% · 2019 약 77%\] 눈금선 없음 풀기 1\.6ms 분석 4\.9ms 프롬프트 넣음$/);
  const text = '1인당 소비량, 2015년 약 62%에서 2019년 약 77%';
  const debug = (stage, verdict, reason, detail) => ({ kind: 'debug', stage, verdict, reason, detail, narrationType: 'interpretation', ts: 2_000_000 });
  const [flow] = buildFlowList({
    debugList: [
      debug('router', 'pass', '확정 interpretation/claim_to_value', '발화="꾸준히 늘었습니다." 후보=[interpretation/claim_to_value]'),
      debug('vlm', 'pass', '생성 interpretation/claim_to_value', `발화="꾸준히 늘었습니다." → "${text}" (3120ms, 예산 6~12어절) · ${summary}`),
    ],
    toMediaMs: () => null,
  });
  const agentStep = flow.stepList.find((step) => step.stage === 'vlm');
  assert.equal(agentStep.text, text);
  assert.equal(agentStep.elapsedMs, 3120);
});
