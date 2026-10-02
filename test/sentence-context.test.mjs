import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeixisCandidateScheduler, CANDIDATE_SOURCE_MAP } from '../src/renderer/core/trigger/deixis-candidate-scheduler.js';
import { MODE_MAP, computeSentenceWaitMs } from '../src/renderer/core/mode/mode-policy.js';

const LOOKAHEAD_MS = 2000;
const SENTENCE_WAIT_MS = 1500;

function makeScheduler({ sentenceWaitMs = SENTENCE_WAIT_MS } = {}) {
  const decisionList = [];
  const timerList = [];
  const scheduler = new DeixisCandidateScheduler({
    onDecide: (decision) => decisionList.push(decision),
    lookaheadMs: LOOKAHEAD_MS, sentenceWaitMs,
    setTimer: (fn, ms) => { timerList.push({ fn, ms, isCleared: false }); return timerList.length - 1; },
    clearTimer: (handle) => { timerList[handle].isCleared = true; },
  });
  return { scheduler, decisionList, timerList };
}

function submitSpeech(scheduler, { utterance, trigger = utterance, leadText = '' }) {
  scheduler.submit({
    source: CANDIDATE_SOURCE_MAP.speech, utterance, trigger, leadText,
    captureTs: 1000, videoTimeMs: 9000, eventVideoTimeMs: 8500,
  });
}

test('대기 후보가 없으면 전사 조각을 붙이지 않는다', () => {
  const { scheduler, timerList, decisionList } = makeScheduler();
  assert.equal(scheduler.appendTranscript({ text: '500만원이 추가된 것을' }), false);
  assert.equal(timerList.length, 0);
  assert.equal(decisionList.length, 0);
});

test('문장이 안 끝났으면 추가로 기다렸다가 앞 조각 + 트리거 + 뒤 조각 문장 전체로 판정한다', () => {
  const { scheduler, timerList, decisionList } = makeScheduler();
  submitSpeech(scheduler, { utterance: '5배', leadText: '보시는 것처럼 단기 수시 연봉 조정 내용을' });
  assert.equal(timerList[0].ms, LOOKAHEAD_MS);

  timerList[0].fn();
  assert.equal(decisionList.length, 0);
  assert.equal(timerList[1].ms, SENTENCE_WAIT_MS);

  assert.equal(scheduler.appendTranscript({ text: '500만원이 추가된 것을 보실 수가' }), true);
  assert.equal(decisionList.length, 0);

  timerList[1].fn();
  assert.equal(decisionList.length, 1);
  const decision = decisionList[0];
  assert.equal(decision.utterance, '보시는 것처럼 단기 수시 연봉 조정 내용을 5배 500만원이 추가된 것을 보실 수가');
  assert.equal(decision.triggerUtterance, '5배');
  assert.equal(decision.leadText, '보시는 것처럼 단기 수시 연봉 조정 내용을');
  assert.equal(decision.followText, '500만원이 추가된 것을 보실 수가');
  assert.equal(decision.isSentenceWaited, true);
  assert.equal(decision.eventVideoTimeMs, 8500);
  assert.equal(decision.captureTs, 1000);
});

test('추가 대기 중 문장 끝 조각이 오면 바로 판정하고 추가 대기 타이머를 푼다', () => {
  const { scheduler, timerList, decisionList } = makeScheduler();
  submitSpeech(scheduler, { utterance: '이 부분을 보시면' });
  timerList[0].fn();
  scheduler.appendTranscript({ text: '매출이 두 배로 늘었습니다' });
  assert.equal(decisionList.length, 1);
  assert.equal(timerList[1].isCleared, true);
  assert.equal(decisionList[0].utterance, '이 부분을 보시면 매출이 두 배로 늘었습니다');
  assert.equal(decisionList[0].isSentenceWaited, true);
});

test('look-ahead 중에 문장 끝 조각이 와도 미리 판정하지 않고, look-ahead 끝에 추가 대기 없이 판정한다', () => {
  const { scheduler, timerList, decisionList } = makeScheduler();
  submitSpeech(scheduler, { utterance: '이 부분을 보시면' });
  scheduler.appendTranscript({ text: '매출이 늘었습니다' });
  assert.equal(decisionList.length, 0);
  timerList[0].fn();
  assert.equal(decisionList.length, 1);
  assert.equal(timerList.length, 1);
  assert.equal(decisionList[0].isSentenceWaited, false);
});

test('트리거 조각이 이미 문장 끝이면 추가 대기 없이 판정한다', () => {
  const { scheduler, timerList, decisionList } = makeScheduler();
  submitSpeech(scheduler, { utterance: '여기가 핵심입니다', trigger: '여기' });
  timerList[0].fn();
  assert.equal(decisionList.length, 1);
  assert.equal(timerList.length, 1);
  assert.equal(decisionList[0].utterance, '여기가 핵심입니다');
});

test('추가 대기가 0 이면 문장이 안 끝나도 look-ahead 끝에 판정한다', () => {
  const { scheduler, timerList, decisionList } = makeScheduler({ sentenceWaitMs: 0 });
  submitSpeech(scheduler, { utterance: '이 부분을', leadText: '보시는 것처럼' });
  timerList[0].fn();
  assert.equal(decisionList.length, 1);
  assert.equal(timerList.length, 1);
  assert.equal(decisionList[0].utterance, '보시는 것처럼 이 부분을');
  assert.equal(decisionList[0].isSentenceWaited, false);
});

test('추가 대기 중 reset 하면 타이머를 풀고 판정하지 않는다', () => {
  const { scheduler, timerList, decisionList } = makeScheduler();
  submitSpeech(scheduler, { utterance: '이 부분을' });
  timerList[0].fn();
  scheduler.reset();
  assert.equal(timerList[1].isCleared, true);
  assert.equal(scheduler.appendTranscript({ text: '봐 주세요' }), false);
  assert.equal(decisionList.length, 0);
});

test('판정이 끝난 뒤 들어온 조각은 붙이지 않는다', () => {
  const { scheduler, timerList } = makeScheduler({ sentenceWaitMs: 0 });
  submitSpeech(scheduler, { utterance: '여기' });
  timerList[0].fn();
  assert.equal(scheduler.appendTranscript({ text: '다음 조각' }), false);
});

test('대기 중 들어온 지시 조각은 트리거 목록에만 더하고 발화는 뒤 조각으로 한 번만 붙는다', () => {
  const { scheduler, timerList, decisionList } = makeScheduler({ sentenceWaitMs: 0 });
  submitSpeech(scheduler, { utterance: '이 부분이', trigger: '이 부분' });
  scheduler.appendTranscript({ text: '저기 그래프와' });
  scheduler.submit({
    source: CANDIDATE_SOURCE_MAP.speech, utterance: '저기 그래프와', trigger: '저기',
    captureTs: 2000, videoTimeMs: 10000,
  });
  timerList[0].fn();
  assert.equal(decisionList[0].utterance, '이 부분이 저기 그래프와');
  assert.deepEqual(decisionList[0].triggerList, ['이 부분', '저기']);
});

test('setSentenceWaitMs 는 0 이상의 숫자만 받는다', () => {
  const { scheduler } = makeScheduler({ sentenceWaitMs: 0 });
  scheduler.setSentenceWaitMs({ sentenceWaitMs: 1500 });
  assert.equal(scheduler.sentenceWaitMs, 1500);
  scheduler.setSentenceWaitMs({ sentenceWaitMs: -1 });
  scheduler.setSentenceWaitMs({ sentenceWaitMs: undefined });
  assert.equal(scheduler.sentenceWaitMs, 1500);
});

test('문장 끝 추가 대기는 동시·성능 모드만 1.5초, 균형·품질 모드는 0', () => {
  assert.equal(computeSentenceWaitMs({ mode: MODE_MAP.realtimeMix }), 1500);
  assert.equal(computeSentenceWaitMs({ mode: MODE_MAP.realtimeSic }), 1500);
  assert.equal(computeSentenceWaitMs({ mode: MODE_MAP.delayed }), 0);
  assert.equal(computeSentenceWaitMs({ mode: MODE_MAP.listening }), 0);
  assert.equal(computeSentenceWaitMs({ mode: 'unknown' }), 0);
});
