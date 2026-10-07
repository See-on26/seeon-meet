import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeixisDetector } from '../src/renderer/core/trigger/deixis-detector.js';
import {
  DeixisCandidateScheduler, CANDIDATE_SOURCE_MAP, SUBMIT_RESULT_MAP,
} from '../src/renderer/core/trigger/deixis-candidate-scheduler.js';
import { MODE_MAP, computeContextHoldMs } from '../src/renderer/core/mode/mode-policy.js';

const LOOKAHEAD_MS = 2500;
const HOLD_MS = 2500;

const thisYear = { type: 'demonstrative', phrase: 'this year' };
const thisChart = { type: 'demonstrative', phrase: 'This chart' };
const grew = { type: 'change', phrase: 'grew' };
const thirtyPercent = { type: 'number', phrase: '30%' };
const thisPart = { type: 'demonstrative', phrase: '이 부분' };
const thisGraph = { type: 'demonstrative', phrase: '이 그래프' };
const rose = { type: 'change', phrase: '올랐습니다' };

function makeScheduler({ holdMs = HOLD_MS, sentenceWaitMs = 0, getLastSpeechWallTs = null } = {}) {
  const decisionList = [];
  const timerList = [];
  const scheduler = new DeixisCandidateScheduler({
    onDecide: (decision) => decisionList.push(decision),
    lookaheadMs: LOOKAHEAD_MS, sentenceWaitMs, holdMs, getLastSpeechWallTs,
    setTimer: (fn, ms) => { timerList.push({ fn, ms, isCleared: false }); return timerList.length - 1; },
    clearTimer: (handle) => { timerList[handle].isCleared = true; },
  });
  return { scheduler, decisionList, timerList };
}

// main 의 handleAsrTranscript 처럼 조각을 먼저 붙이고, 판정이 나지 않았으면 후보를 낸다.
function receiveChunk(scheduler, { text, candidateList = [], endTs, captureTs = endTs }) {
  const appendResult = scheduler.appendTranscript({ text, endTs, candidateList });
  if (appendResult.isDecided || !candidateList.length) return { ...appendResult, submitResult: null };
  const submitResult = scheduler.submit({
    source: CANDIDATE_SOURCE_MAP.speech, utterance: text,
    trigger: candidateList.map((candidate) => candidate.phrase).join(', '), candidateList,
    captureTs, videoTimeMs: captureTs, eventVideoTimeMs: captureTs - 500, chunkEndWallTs: endTs,
  });
  return { ...appendResult, submitResult };
}

test('판정 뒤 보류 중에 온 바로 뒤 후보는 버리지 않고 같은 결정에 합쳐 한 번에 판단을 받는다', async () => {
  const { scheduler, decisionList, timerList } = makeScheduler();
  assert.equal(receiveChunk(scheduler, { text: 'Revenue for this year.', candidateList: [thisYear], endTs: 1000 }).submitResult,
    SUBMIT_RESULT_MAP.started);
  timerList[0].fn();
  assert.equal(decisionList.length, 1);
  assert.equal(timerList[1].ms, HOLD_MS);

  const second = receiveChunk(scheduler, {
    text: 'This chart shows that revenue grew 30%.', candidateList: [thisChart, grew, thirtyPercent], endTs: 3500,
  });
  assert.equal(second.isAppended, true);
  assert.equal(second.submitResult, SUBMIT_RESULT_MAP.merged);

  timerList[1].fn();
  const sealed = await decisionList[0].whenSealed;
  assert.equal(decisionList.length, 1, '새 결정을 따로 만들지 않는다');
  assert.equal(sealed.utterance, 'Revenue for this year. This chart shows that revenue grew 30%.');
  assert.equal(sealed.triggerUtterance, 'Revenue for this year.');
  assert.deepEqual(sealed.candidateList.map((candidate) => candidate.phrase), ['this year', 'This chart', 'grew', '30%']);
  assert.deepEqual(sealed.triggerList, ['this year', 'This chart, grew, 30%']);
  assert.equal(sealed.mergedChunkCount, 1);
  assert.equal(sealed.decisionId, decisionList[0].decisionId);
  assert.equal(sealed.eventVideoTimeMs, 500, '해설 자리는 첫 후보 시각 그대로다');
});

test('판정 때 넘긴 결정은 그 뒤 합친 것으로 바뀌지 않는다', async () => {
  const { scheduler, decisionList, timerList } = makeScheduler();
  receiveChunk(scheduler, { text: '오른쪽에 카드가 두 장 있는데요', candidateList: [{ type: 'adjective_noun', phrase: '오른쪽' }], endTs: 1000 });
  timerList[0].fn();
  receiveChunk(scheduler, { text: '이 부분이 오늘의 핵심입니다', candidateList: [thisPart], endTs: 3500 });
  timerList[1].fn();
  const sealed = await decisionList[0].whenSealed;
  assert.equal(decisionList[0].utterance, '오른쪽에 카드가 두 장 있는데요');
  assert.equal(decisionList[0].candidateList.length, 1);
  assert.equal(sealed.utterance, '오른쪽에 카드가 두 장 있는데요 이 부분이 오늘의 핵심입니다');
  assert.equal(sealed.candidateList.length, 2);
});

test('보류 중 후보 없는 조각은 모아 두었다가 뒤에 후보 조각이 오면 순서대로 함께 합친다', async () => {
  const { scheduler, decisionList, timerList } = makeScheduler();
  receiveChunk(scheduler, { text: '이 그래프를 보시면', candidateList: [thisGraph], endTs: 1000 });
  timerList[0].fn();
  const plain = receiveChunk(scheduler, { text: '상반기에는 비슷하다가', endTs: 3000 });
  assert.equal(plain.isAppended, false, '후보가 오기 전에는 발화에 넣지 않는다');
  receiveChunk(scheduler, { text: '하반기에 크게 올랐습니다', candidateList: [rose], endTs: 4500 });
  timerList[1].fn();
  const sealed = await decisionList[0].whenSealed;
  assert.equal(sealed.utterance, '이 그래프를 보시면 상반기에는 비슷하다가 하반기에 크게 올랐습니다');
  assert.equal(sealed.followText, '상반기에는 비슷하다가 하반기에 크게 올랐습니다');
  assert.equal(sealed.mergedChunkCount, 2);
});

test('보류 중 후보가 끝내 안 오면 모아 둔 조각은 발화에 넣지 않는다', async () => {
  const { scheduler, decisionList, timerList } = makeScheduler();
  receiveChunk(scheduler, { text: '여기를 보시면', candidateList: [{ type: 'demonstrative', phrase: '여기' }], endTs: 1000 });
  timerList[0].fn();
  receiveChunk(scheduler, { text: '감사합니다', endTs: 3000 });
  timerList[1].fn();
  const sealed = await decisionList[0].whenSealed;
  assert.equal(sealed.utterance, '여기를 보시면');
  assert.equal(sealed.mergedChunkCount, 0);
});

test('보류가 끝난 뒤 온 후보는 버리지 않고 새 후보로 따로 판단한다', async () => {
  const { scheduler, decisionList, timerList } = makeScheduler();
  receiveChunk(scheduler, { text: 'Revenue for this year.', candidateList: [thisYear], endTs: 1000 });
  timerList[0].fn();
  timerList[1].fn();
  await decisionList[0].whenSealed;

  const late = receiveChunk(scheduler, { text: 'This chart shows that revenue grew 30%.', candidateList: [thisChart], endTs: 3500 });
  assert.equal(late.submitResult, SUBMIT_RESULT_MAP.started);
  timerList[2].fn();
  timerList[3].fn();
  assert.equal(decisionList.length, 2);
  const sealed = await decisionList[1].whenSealed;
  assert.equal(sealed.utterance, 'This chart shows that revenue grew 30%.');
  assert.notEqual(sealed.decisionId, decisionList[0].decisionId);
});

test('보류가 없는 모드는 판정 직후 온 후보도 4초를 기다리지 않고 새로 판단한다', async () => {
  const { scheduler, decisionList, timerList } = makeScheduler({ holdMs: 0 });
  receiveChunk(scheduler, { text: '이 그래프를 보시면', candidateList: [thisGraph], endTs: 1000, captureTs: 1000 });
  timerList[0].fn();
  const sealed = await decisionList[0].whenSealed;
  assert.equal(sealed.utterance, '이 그래프를 보시면');
  assert.equal(timerList.length, 1, '보류 타이머가 없다');

  const next = receiveChunk(scheduler, { text: '올랐습니다', candidateList: [rose], endTs: 3500, captureTs: 3500 });
  assert.equal(next.submitResult, SUBMIT_RESULT_MAP.started);
  timerList[1].fn();
  assert.equal(decisionList.length, 2);
});

test('문장 끝을 기다리다 판정을 낸 조각의 후보도 그 판단에 들어간다', async () => {
  const { scheduler, decisionList, timerList } = makeScheduler({ holdMs: 0, sentenceWaitMs: 1500 });
  receiveChunk(scheduler, { text: '이 그래프를 보시면', candidateList: [thisGraph], endTs: 1000 });
  timerList[0].fn();
  assert.equal(decisionList.length, 0);
  const closing = receiveChunk(scheduler, { text: '30% 올랐습니다', candidateList: [thirtyPercent, rose], endTs: 3000 });
  assert.equal(closing.isDecided, true);
  assert.equal(closing.submitResult, null, '같은 조각으로 새 후보를 만들지 않는다');
  const sealed = await decisionList[0].whenSealed;
  assert.deepEqual(sealed.candidateList.map((candidate) => candidate.phrase), ['이 그래프', '30%', '올랐습니다']);
  assert.equal(sealed.utterance, '이 그래프를 보시면 30% 올랐습니다');
});

test('look-ahead 중 조각의 후보는 appendTranscript 와 submit 이 둘 다 붙여도 한 번만 들어간다', async () => {
  const { scheduler, decisionList, timerList } = makeScheduler({ holdMs: 0 });
  receiveChunk(scheduler, { text: '이 그래프를 보시면', candidateList: [thisGraph], endTs: 1000 });
  const follow = receiveChunk(scheduler, { text: '30% 늘었습니다', candidateList: [thirtyPercent], endTs: 2500 });
  assert.equal(follow.submitResult, SUBMIT_RESULT_MAP.absorbed);
  timerList[0].fn();
  const sealed = await decisionList[0].whenSealed;
  assert.deepEqual(sealed.candidateList.map((candidate) => candidate.phrase), ['이 그래프', '30%']);
  assert.deepEqual(sealed.triggerList, ['이 그래프', '30%']);
  assert.equal(sealed.utterance, '이 그래프를 보시면 30% 늘었습니다');
});

test('보류 중에 순서가 뒤바뀌어 온 앞 조각은 뒤 조각으로 붙이지 않는다', async () => {
  const { scheduler, decisionList, timerList } = makeScheduler();
  receiveChunk(scheduler, { text: '이 부분이', candidateList: [thisPart], endTs: 2000 });
  timerList[0].fn();
  assert.equal(scheduler.appendTranscript({ text: '먼저 녹음된 조각', endTs: 1500, candidateList: [thisGraph] }).isAppended, false);
  timerList[1].fn();
  const sealed = await decisionList[0].whenSealed;
  assert.equal(sealed.utterance, '이 부분이');
});

test('보류 중 reset 하면 보류 타이머를 풀고 확정 결정은 null 이며, 다음 후보는 새로 시작한다', async () => {
  const { scheduler, decisionList, timerList } = makeScheduler();
  receiveChunk(scheduler, { text: '이 부분이', candidateList: [thisPart], endTs: 1000 });
  timerList[0].fn();
  scheduler.reset();
  assert.equal(timerList[1].isCleared, true);
  assert.equal(await decisionList[0].whenSealed, null);
  assert.equal(receiveChunk(scheduler, { text: '이 그래프', candidateList: [thisGraph], endTs: 3000 }).submitResult,
    SUBMIT_RESULT_MAP.started);
});

test('보류 중인 결정에는 포인팅 영역을 붙이지 않는다(화면은 판정 때 이미 찍었다)', async () => {
  const { scheduler, decisionList, timerList } = makeScheduler();
  receiveChunk(scheduler, { text: '이 부분이', candidateList: [thisPart], endTs: 1000 });
  timerList[0].fn();
  assert.equal(scheduler.attachPointing({ region: { x: 0, y: 0, w: 1, h: 1 } }), false);
  scheduler.submit({
    source: CANDIDATE_SOURCE_MAP.speech, utterance: '이 그래프', trigger: '이 그래프', candidateList: [thisGraph],
    region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, pointingOrderHint: '1) 왼쪽 위',
    captureTs: 3000, videoTimeMs: 3000, chunkEndWallTs: 3000,
  });
  timerList[1].fn();
  const sealed = await decisionList[0].whenSealed;
  assert.equal(sealed.region, null);
  assert.equal(sealed.pointingOrderHint, '');
  assert.equal(sealed.candidateList.length, 2);
});

test('보류가 길면(품질 모드) look-ahead 길이까지만 합치고, 그 뒤 후보는 앞 결정이 보류 중이어도 새로 판단한다', async () => {
  const longHoldMs = computeContextHoldMs({ mode: MODE_MAP.listening });
  const { scheduler, decisionList, timerList } = makeScheduler({ holdMs: longHoldMs });
  receiveChunk(scheduler, { text: '이 그래프를 보시면', candidateList: [thisGraph], endTs: 1000 });
  timerList[0].fn();
  assert.equal(timerList[1].ms, longHoldMs);
  assert.equal(timerList[2].ms, LOOKAHEAD_MS, '합치는 시간은 look-ahead 길이까지다');

  assert.equal(receiveChunk(scheduler, { text: '30% 올랐습니다', candidateList: [thirtyPercent], endTs: 3500 }).submitResult,
    SUBMIT_RESULT_MAP.merged);
  timerList[2].fn();
  receiveChunk(scheduler, { text: '감사합니다', endTs: 5000 });
  assert.equal(receiveChunk(scheduler, { text: '이 부분이 핵심입니다', candidateList: [thisPart], endTs: 6000 }).submitResult,
    SUBMIT_RESULT_MAP.started);
  timerList[3].fn();
  assert.equal(decisionList.length, 2);

  timerList[1].fn();
  const first = await decisionList[0].whenSealed;
  assert.equal(first.utterance, '이 그래프를 보시면 30% 올랐습니다');
  assert.deepEqual(first.candidateList.map((candidate) => candidate.phrase), ['이 그래프', '30%']);

  scheduler.reset();
  assert.equal(await decisionList[1].whenSealed, null, '보류 중인 결정이 여럿이어도 reset 이 모두 버린다');
  assert.equal(timerList[4].isCleared, true);
  assert.equal(timerList[5].isCleared, true);
});

test('균형·품질 모드만 판단 전 보류가 있고 동시·성능 모드는 없다', () => {
  assert.ok(computeContextHoldMs({ mode: MODE_MAP.delayed }) > 0);
  assert.ok(computeContextHoldMs({ mode: MODE_MAP.listening }) > 0);
  assert.equal(computeContextHoldMs({ mode: MODE_MAP.realtimeSic }), 0);
  assert.equal(computeContextHoldMs({ mode: MODE_MAP.realtimeMix }), 0);
});

test('탐지기는 바로 이어 온 조각의 후보도 버리지 않고 이벤트를 낸다', () => {
  const eventList = [];
  const detector = new DeixisDetector({ onDeixis: (event) => eventList.push(event) });
  detector.handleTranscript({ text: 'Revenue for this year.', candidateList: [thisYear], captureTs: 1000 });
  detector.handleTranscript({ text: 'This chart shows that revenue grew 30%.', candidateList: [thisChart, grew], captureTs: 3500 });
  assert.equal(eventList.length, 2);
  assert.equal(eventList[1].trigger, 'This chart, grew');
});
