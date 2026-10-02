import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeixisCandidateScheduler, CANDIDATE_SOURCE_MAP } from '../src/renderer/core/trigger/deixis-candidate-scheduler.js';
import { judgeScreenDependency, SCREEN_DEPENDENCY_REASON_MAP } from '../src/renderer/core/trigger/screen-dependency.js';

function makeScheduler() {
  const decisionList = [];
  const timerList = [];
  const scheduler = new DeixisCandidateScheduler({
    onDecide: (decision) => decisionList.push(decision),
    setTimer: (fn) => { timerList.push(fn); return timerList.length; },
    clearTimer: () => {},
  });
  return { scheduler, decisionList, timerList };
}

test('포인팅 출처는 더 이상 없다', () => {
  assert.deepEqual(CANDIDATE_SOURCE_MAP, { speech: 'speech' });
});

test('대기 후보가 없으면 포인터 영역 첨부는 아무 일도 하지 않는다', () => {
  const { scheduler, decisionList, timerList } = makeScheduler();
  const isAttached = scheduler.attachPointing({ region: { x: 0, y: 0, w: 10, h: 10 }, pointingOrderHint: '1) 왼쪽 위' });
  assert.equal(isAttached, false);
  assert.equal(timerList.length, 0);
  assert.equal(decisionList.length, 0);
});

test('발화 후보가 대기 중이면 비어 있는 영역·순서 힌트만 채운다', () => {
  const { scheduler, decisionList, timerList } = makeScheduler();
  scheduler.submit({ source: CANDIDATE_SOURCE_MAP.speech, utterance: '이 부분', trigger: '이 부분', captureTs: 0, videoTimeMs: 0 });
  const region = { x: 1, y: 2, w: 3, h: 4 };
  assert.equal(scheduler.attachPointing({ region, pointingOrderHint: '1) 가운데' }), true);
  timerList[0]();
  assert.deepEqual(decisionList[0].region, region);
  assert.equal(decisionList[0].pointingOrderHint, '1) 가운데');
});

test('이미 영역이 있는 후보는 덮어쓰지 않는다', () => {
  const { scheduler, decisionList, timerList } = makeScheduler();
  const firstRegion = { x: 0, y: 0, w: 5, h: 5 };
  scheduler.submit({ source: CANDIDATE_SOURCE_MAP.speech, utterance: '여기', trigger: '여기', region: firstRegion, captureTs: 0, videoTimeMs: 0 });
  scheduler.attachPointing({ region: { x: 9, y: 9, w: 9, h: 9 } });
  timerList[0]();
  assert.deepEqual(decisionList[0].region, firstRegion);
});

test('발화 트리거는 화면 의존으로 통과한다', () => {
  const verdict = judgeScreenDependency({ source: CANDIDATE_SOURCE_MAP.speech, utterance: '여기를 보시면' });
  assert.equal(verdict.isScreenDependent, true);
  assert.equal(verdict.reason, SCREEN_DEPENDENCY_REASON_MAP.speechTrigger);
  assert.equal(verdict.trigger, '여기');
});

test('발화가 아닌 출처는 통과하지 않는다', () => {
  const verdict = judgeScreenDependency({ source: 'pointing', utterance: '' });
  assert.equal(verdict.isScreenDependent, false);
  assert.equal(verdict.reason, SCREEN_DEPENDENCY_REASON_MAP.unsupportedSource);
});
