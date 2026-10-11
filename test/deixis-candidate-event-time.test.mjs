import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { attachCandidateEventVideoTime } from '../src/renderer/core/capture/video-time.js';
import { DeixisCandidateScheduler, CANDIDATE_SOURCE_MAP } from '../src/renderer/core/trigger/deixis-candidate-scheduler.js';

const require = createRequire(import.meta.url);
const { resolveGapEventVideoTimeMs } = require('../src/main/caption-pipeline/router/unified-router.js');

const chunk = {
  chunkStartTs: 10000, chunkEndTs: 12500, nowWallTs: 13000, nowVideoTimeMs: 50000,
  segmentList: [
    { startSec: 0, endSec: 1.0, text: '이 그래프를 보시면' },
    { startSec: 1.2, endSec: 2.4, text: '매출이 30% 올랐습니다' },
  ],
};

test('후보마다 그 후보가 든 세그먼트 끝의 영상 시각을 붙인다', () => {
  const candidateList = attachCandidateEventVideoTime({
    ...chunk,
    candidateList: [{ type: 'demonstrative', phrase: '이 그래프' }, { type: 'numeric', phrase: '30%' }],
  });
  assert.deepEqual(candidateList.map((candidate) => [candidate.phrase, candidate.eventVideoTimeMs]),
    [['이 그래프', 48000], ['30%', 49400]]);
});

test('세그먼트에서 후보를 못 찾으면 마지막 세그먼트 끝, 구가 없는 후보는 그대로 둔다', () => {
  const candidateList = attachCandidateEventVideoTime({
    ...chunk,
    candidateList: [{ type: 'scale', phrase: '꽤 넓죠' }, { type: 'demonstrative', phrase: '' }],
  });
  assert.equal(candidateList[0].eventVideoTimeMs, 49400);
  assert.deepEqual(candidateList[1], { type: 'demonstrative', phrase: '' });
});

test('판단 전 보류 중에 합쳐진 뒤 조각의 후보도 자기 발화 시각을 결정까지 들고 간다', async () => {
  const timerList = [];
  let decision = null;
  const scheduler = new DeixisCandidateScheduler({
    onDecide: (fired) => { decision = fired; }, holdMs: 2500,
    setTimer: (fn, ms) => { timerList.push({ fn, ms }); return timerList.length; }, clearTimer: () => {},
  });
  scheduler.submit({
    source: CANDIDATE_SOURCE_MAP.speech, utterance: 'Revenue for this year.', trigger: 'this year',
    candidateList: [{ type: 'demonstrative', phrase: 'this year', eventVideoTimeMs: 17400 }],
    captureTs: 0, videoTimeMs: 17400, eventVideoTimeMs: 17400, chunkEndWallTs: 1000,
  });
  timerList.shift().fn();
  scheduler.appendTranscript({
    text: 'This chart shows that revenue grew 30%.', endTs: 3500,
    candidateList: [{ type: 'numeric', phrase: '30%', eventVideoTimeMs: 19900 }],
  });
  timerList.shift().fn();
  const sealed = await decision.whenSealed;
  assert.deepEqual(sealed.candidateList.map((candidate) => [candidate.phrase, candidate.eventVideoTimeMs]),
    [['this year', 17400], ['30%', 19900]]);
  assert.equal(sealed.eventVideoTimeMs, 17400);
});

test('해설 자리는 공백(O) 판정을 받은 후보 중 가장 이른 발화 시각이다', () => {
  const judgeList = [
    { phrase: 'this year', isGap: false, eventVideoTimeMs: 17400 },
    { phrase: '30%', isGap: true, eventVideoTimeMs: 19900 },
    { phrase: 'grew', isGap: true, eventVideoTimeMs: 19600 },
  ];
  assert.equal(resolveGapEventVideoTimeMs({ judgeList, fallbackMs: 17400 }), 19600);
});

test('공백 후보가 없거나 시각이 없으면 결정의 원 사건 시각을 그대로 쓴다', () => {
  assert.equal(resolveGapEventVideoTimeMs({ judgeList: [{ isGap: false, eventVideoTimeMs: 3000 }], fallbackMs: 1000 }), 1000);
  assert.equal(resolveGapEventVideoTimeMs({ judgeList: [{ isGap: true, eventVideoTimeMs: null }], fallbackMs: 1000 }), 1000);
  assert.equal(resolveGapEventVideoTimeMs({ judgeList: [], fallbackMs: null }), null);
});
