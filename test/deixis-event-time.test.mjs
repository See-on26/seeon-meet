import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeixisDetector } from '../src/renderer/core/trigger/deixis-detector.js';
import { DeixisCandidateScheduler, CANDIDATE_SOURCE_MAP } from '../src/renderer/core/trigger/deixis-candidate-scheduler.js';

test('지시 탐지 이벤트에 발화 끝 벽시계 시각이 실린다', () => {
  const eventList = [];
  const detector = new DeixisDetector({ onDeixis: (event) => eventList.push(event) });
  detector.handleTranscript({ text: '여기를 보시면', captureTs: 5000, eventWallTs: 4200 });
  assert.equal(eventList.length, 1);
  assert.equal(eventList[0].eventWallTs, 4200);
});

test('eventWallTs 를 안 주면 null', () => {
  const eventList = [];
  const detector = new DeixisDetector({ onDeixis: (event) => eventList.push(event) });
  detector.handleTranscript({ text: '여기를 보시면', captureTs: 5000 });
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
