import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { attachCandidateEventVideoTime } from '../src/renderer/core/capture/video-time.js';
import { DeixisCandidateScheduler, CANDIDATE_SOURCE_MAP } from '../src/renderer/core/trigger/deixis-candidate-scheduler.js';

const require = createRequire(import.meta.url);
const {
  resolveNarrationEventVideoTimeMs, parseJudgeText, toNarrationCandidateList,
} = require('../src/main/caption-pipeline/router/unified-router.js');
const { selectGeneratableCandidate } = require('../src/main/caption-pipeline/orchestrator/candidate-selector.js');

// 벽시계 10000~12500 조각, 지금 벽시계 13000 = 영상 50000 → 벽시계 w 는 영상 w + 37000.
const chunk = { chunkStartTs: 10000, chunkEndTs: 12500, nowWallTs: 13000, nowVideoTimeMs: 50000 };
const twoSegmentChunk = {
  ...chunk,
  text: '이 그래프를 보시면 매출이 30% 올랐습니다',
  segmentList: [
    { startSec: 0, endSec: 1.0, text: '이 그래프를 보시면' },
    { startSec: 1.2, endSec: 2.4, text: '매출이 30% 올랐습니다' },
  ],
};

test('후보마다 그 후보가 든 세그먼트 끝의 영상 시각을 붙인다', () => {
  const { text } = twoSegmentChunk;
  const candidateList = attachCandidateEventVideoTime({
    ...twoSegmentChunk,
    candidateList: [
      { type: 'demonstrative', phrase: '이 그래프', start: 0 },
      { type: 'number', phrase: '30%', start: text.indexOf('30%') },
    ],
  });
  assert.deepEqual(candidateList.map((candidate) => [candidate.phrase, candidate.eventVideoTimeMs]),
    [['이 그래프', 48000], ['30%', 49400]]);
});

test('같은 구가 한 조각에 두 번 나오면 글자 위치로 실제 자리의 세그먼트를 고른다', () => {
  const text = '이것 보시고 다시 이것';
  const candidateList = attachCandidateEventVideoTime({
    ...chunk, text,
    segmentList: [{ startSec: 0, endSec: 1.0, text: '이것 보시고' }, { startSec: 1.2, endSec: 2.4, text: '다시 이것' }],
    candidateList: [
      { type: 'demonstrative', phrase: '이것', start: 0 },
      { type: 'demonstrative', phrase: '이것', start: text.lastIndexOf('이것') },
    ],
  });
  assert.deepEqual(candidateList.map((candidate) => candidate.eventVideoTimeMs), [48000, 49400]);
});

test('글자 위치를 모르면 구가 든 세그먼트, 못 찾으면 마지막 세그먼트 끝, 구가 없는 후보는 그대로 둔다', () => {
  const candidateList = attachCandidateEventVideoTime({
    ...twoSegmentChunk,
    candidateList: [
      { type: 'demonstrative', phrase: '이 그래프' },
      { type: 'scale', phrase: '꽤 넓죠' },
      { type: 'demonstrative', phrase: '' },
    ],
  });
  assert.equal(candidateList[0].eventVideoTimeMs, 48000);
  assert.equal(candidateList[1].eventVideoTimeMs, 49400);
  assert.deepEqual(candidateList[2], { type: 'demonstrative', phrase: '' });
});

function createManualScheduler({ holdMs }) {
  const timerList = [];
  const decisionList = [];
  const scheduler = new DeixisCandidateScheduler({
    onDecide: (fired) => decisionList.push(fired), holdMs,
    setTimer: (fn) => { timerList.push(fn); return timerList.length; }, clearTimer: () => {},
  });
  return { scheduler, timerList, decisionList };
}

const firstSubmit = {
  source: CANDIDATE_SOURCE_MAP.speech, utterance: 'Revenue for this year.', trigger: 'this year',
  candidateList: [{ type: 'demonstrative', phrase: 'this year', eventVideoTimeMs: 17400 }],
  captureTs: 0, videoTimeMs: 17400, eventVideoTimeMs: 17400, chunkEndWallTs: 1000,
};
const followChunk = {
  text: 'This chart shows that revenue grew 30%.', endTs: 3500,
  candidateList: [{ type: 'number', phrase: '30%', eventVideoTimeMs: 19900 }],
};

test('look-ahead 중에 합쳐진 뒤 조각의 후보도 자기 발화 시각을 결정까지 들고 간다', async () => {
  const { scheduler, timerList, decisionList } = createManualScheduler({ holdMs: 0 });
  scheduler.submit(firstSubmit);
  scheduler.appendTranscript(followChunk);
  timerList.shift()();
  const sealed = await decisionList[0].whenSealed;
  assert.deepEqual(sealed.candidateList.map((candidate) => [candidate.phrase, candidate.eventVideoTimeMs]),
    [['this year', 17400], ['30%', 19900]]);
  assert.equal(sealed.eventVideoTimeMs, 17400);
});

test('판단 전 보류 중에 합쳐진 뒤 조각의 후보도 자기 발화 시각을 결정까지 들고 간다', async () => {
  const { scheduler, timerList, decisionList } = createManualScheduler({ holdMs: 2500 });
  scheduler.submit(firstSubmit);
  timerList.shift()();
  scheduler.appendTranscript(followChunk);
  timerList.shift()();
  const sealed = await decisionList[0].whenSealed;
  assert.deepEqual(sealed.candidateList.map((candidate) => [candidate.phrase, candidate.eventVideoTimeMs]),
    [['this year', 17400], ['30%', 19900]]);
});

test('판단 결과를 읽어도 후보의 발화 시각이 남는다', () => {
  const judgeList = parseJudgeText({
    text: '{"judgeList":[{"id":1,"gap":"O","reason":"r"},{"id":2,"gap":"X"}]}',
    candidateList: [
      { id: 1, type: 'number', phrase: '30%', eventVideoTimeMs: 19900 },
      { id: 2, type: 'demonstrative', phrase: 'this', eventVideoTimeMs: 17400 },
    ],
  });
  assert.deepEqual(judgeList.map((entry) => [entry.phrase, entry.isGap, entry.eventVideoTimeMs]),
    [['30%', true, 19900], ['this', false, 17400]]);
});

function resolveFromJudgeList({ judgeList, isScaleEnabled = true, fallbackMs = 17400 }) {
  const { selected } = selectGeneratableCandidate({ candidateList: toNarrationCandidateList(judgeList), isScaleEnabled });
  return { selected, eventVideoTimeMs: resolveNarrationEventVideoTimeMs({ judgeList, selectedCandidate: selected, fallbackMs }) };
}

test('해석 해설이 앞 지시 구를 흡수하면 해설 자리는 두 구 가운데 늦게 말한 시각이다', () => {
  const { selected, eventVideoTimeMs } = resolveFromJudgeList({
    judgeList: [
      { type: 'demonstrative', phrase: 'this year', isGap: true, eventVideoTimeMs: 17400 },
      { type: 'number', phrase: '30%', isGap: true, eventVideoTimeMs: 19900 },
    ],
  });
  assert.equal(selected.anchor, '30%');
  assert.deepEqual(selected.mergedAnchorList, ['this year']);
  assert.equal(eventVideoTimeMs, 19900);
});

test('해설이 다루지 않는 공백 구의 시각은 쓰지 않는다(척도를 끈 경우)', () => {
  const { selected, eventVideoTimeMs } = resolveFromJudgeList({
    isScaleEnabled: false,
    judgeList: [
      { type: 'scale', phrase: '꽤 넓죠', isGap: true, eventVideoTimeMs: 20500 },
      { type: 'demonstrative', phrase: '이 지도', isGap: true, eventVideoTimeMs: 18200 },
    ],
  });
  assert.equal(selected.anchor, '이 지도');
  assert.equal(eventVideoTimeMs, 18200);
});

test('해설이 다루는 구의 시각을 모르거나 고른 후보가 없으면 결정의 원 사건 시각을 쓴다', () => {
  assert.equal(resolveNarrationEventVideoTimeMs({
    judgeList: [{ phrase: '30%', isGap: true, eventVideoTimeMs: null }], selectedCandidate: { anchor: '30%' }, fallbackMs: 1000,
  }), 1000);
  assert.equal(resolveNarrationEventVideoTimeMs({
    judgeList: [{ phrase: '30%', isGap: false, eventVideoTimeMs: 3000 }], selectedCandidate: null, fallbackMs: 1000,
  }), 1000);
  assert.equal(resolveNarrationEventVideoTimeMs({ judgeList: [], selectedCandidate: null, fallbackMs: null }), null);
});
