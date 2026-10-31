import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeixisDetector } from '../src/renderer/core/trigger/deixis-detector.js';
import { DeixisCandidateScheduler, CANDIDATE_SOURCE_MAP } from '../src/renderer/core/trigger/deixis-candidate-scheduler.js';

const here = { type: 'demonstrative', phrase: '여기', start: 0, end: 2 };

test('지시 탐지 이벤트에 발화 끝 벽시계 시각이 실린다', () => {
  const eventList = [];
  const detector = new DeixisDetector({ onDeixis: (event) => eventList.push(event) });
  detector.handleTranscript({ text: '여기를 보시면', candidateList: [here], captureTs: 5000, eventWallTs: 4200 });
  assert.equal(eventList.length, 1);
  assert.equal(eventList[0].eventWallTs, 4200);
});

test('eventWallTs 를 안 주면 null', () => {
  const eventList = [];
  const detector = new DeixisDetector({ onDeixis: (event) => eventList.push(event) });
  detector.handleTranscript({ text: '여기를 보시면', candidateList: [here], captureTs: 5000 });
  assert.equal(eventList[0].eventWallTs, null);
});

test('후보 스케줄러는 원 사건 영상 시각을 결정까지 운반한다', () => {
  const decisionList = [];
  let fireTimer = null;
  const scheduler = new DeixisCandidateScheduler({
    onDecide: (decision) => decisionList.push(decision),
    setTimer: (fn) => { fireTimer = fn; return 1; },
    clearTimer: () => {},
  });
  scheduler.submit({
    source: CANDIDATE_SOURCE_MAP.speech, utterance: '여기', trigger: '여기',
    captureTs: 100, videoTimeMs: 9000, eventVideoTimeMs: 8500,
  });
  fireTimer();
  assert.equal(decisionList[0].eventVideoTimeMs, 8500);
});

test('발화 끝 시각을 트리거로 계산하도록 resolver 를 받는다', () => {
  const eventList = [];
  const triggerList = [];
  const detector = new DeixisDetector({ onDeixis: (event) => eventList.push(event) });
  detector.handleTranscript({
    text: '여기를 보시면 매출이 늘었습니다', captureTs: 5000,
    candidateList: [here, { type: 'change', phrase: '늘었습니다', start: 12, end: 17 }],
    resolveEventWallTs: ({ trigger }) => { triggerList.push(trigger); return 4321; },
  });
  assert.deepEqual(triggerList, ['여기']);
  assert.equal(eventList[0].trigger, '여기, 늘었습니다');
  assert.equal(eventList[0].candidateList.length, 2);
  assert.equal(eventList[0].eventWallTs, 4321);
});

test('후보가 없는 조각은 이벤트를 내지 않는다', () => {
  const eventList = [];
  const detector = new DeixisDetector({ onDeixis: (event) => eventList.push(event) });
  assert.equal(detector.handleTranscript({ text: '안녕하세요', candidateList: [], captureTs: 5000 }), null);
  assert.equal(eventList.length, 0);
});

test('대기 중에 들어온 조각의 후보도 모아 한 번에 판단을 받는다', () => {
  const decisionList = [];
  let fireTimer = null;
  const scheduler = new DeixisCandidateScheduler({
    onDecide: (decision) => decisionList.push(decision),
    setTimer: (fn) => { fireTimer = fn; return 1; },
    clearTimer: () => {},
  });
  const here = { type: 'demonstrative', phrase: '여기', start: 0, end: 2 };
  const percent = { type: 'number', phrase: '30%', start: 0, end: 3 };
  scheduler.submit({ source: CANDIDATE_SOURCE_MAP.speech, utterance: '여기 보시면', trigger: '여기', candidateList: [here], captureTs: 100, videoTimeMs: 0 });
  scheduler.submit({ source: CANDIDATE_SOURCE_MAP.speech, utterance: '30%예요', trigger: '30%', candidateList: [percent, here], captureTs: 900, videoTimeMs: 0 });
  fireTimer();
  assert.deepEqual(decisionList[0].candidateList.map((candidate) => candidate.phrase), ['여기', '30%']);
});
