import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SilenceTrigger, evaluateSilencePrecondition, SILENCE_TRIGGER_MS, LIVE_SILENCE_TRIGGER_MS, SILENCE_SKIP_REASON_MAP,
} from '../src/renderer/core/trigger/silence-trigger.js';

test('마지막 말소리 뒤 5초가 지나면 한 번 발동한다', () => {
  const trigger = new SilenceTrigger();
  assert.equal(SILENCE_TRIGGER_MS, 5000);
  assert.equal(trigger.update({ nowPerf: 5999, lastHeardAt: 1000 }), false);
  assert.equal(trigger.update({ nowPerf: 6000, lastHeardAt: 1000 }), true);
  assert.equal(trigger.update({ nowPerf: 9000, lastHeardAt: 1000 }), false);
});

test('말소리가 다시 들린 뒤의 무음에서는 또 발동한다', () => {
  const trigger = new SilenceTrigger();
  trigger.update({ nowPerf: 6000, lastHeardAt: 1000 });
  assert.equal(trigger.update({ nowPerf: 7000, lastHeardAt: 6900 }), false);
  assert.equal(trigger.update({ nowPerf: 11900, lastHeardAt: 6900 }), true);
});

test('말소리를 한 번도 듣지 못했으면 발동하지 않는다', () => {
  const trigger = new SilenceTrigger();
  assert.equal(trigger.update({ nowPerf: 60000, lastHeardAt: 0 }), false);
});

test('reset 이전에 들은 말소리로는 발동하지 않는다', () => {
  const trigger = new SilenceTrigger();
  trigger.reset({ nowPerf: 10000 });
  assert.equal(trigger.update({ nowPerf: 20000, lastHeardAt: 9000 }), false);
  assert.equal(trigger.update({ nowPerf: 26000, lastHeardAt: 21000 }), true);
});

const readyInput = {
  slideLabel: '3', recentTranscript: '여러분, 이 사진을 한번 보시죠.',
  wordBudget: { minWordCount: 5, maxWordCount: 12, isDroppable: false },
};

test('공유 화면·직전 발화·어절 예산이 있으면 보낼 수 있다', () => {
  assert.deepEqual(evaluateSilencePrecondition(readyInput), { isReady: true, reason: null });
});

test('공유 화면(슬라이드)이 없으면 보내지 않는다', () => {
  assert.deepEqual(
    evaluateSilencePrecondition({ ...readyInput, slideLabel: null }),
    { isReady: false, reason: SILENCE_SKIP_REASON_MAP.noScreen },
  );
});

test('직전 발화가 없으면 단서가 있을 수 없어 보내지 않는다', () => {
  assert.deepEqual(
    evaluateSilencePrecondition({ ...readyInput, recentTranscript: '  ' }),
    { isReady: false, reason: SILENCE_SKIP_REASON_MAP.noUtterance },
  );
});

test('어절 예산이 하한에 못 미치면 보내지 않는다', () => {
  assert.deepEqual(
    evaluateSilencePrecondition({ ...readyInput, wordBudget: { minWordCount: 5, maxWordCount: 12, isDroppable: true } }),
    { isReady: false, reason: SILENCE_SKIP_REASON_MAP.budget },
  );
});

test('마이크 질문·일시정지 중에는 세지 않고, 끝난 뒤 새 말소리부터 다시 센다', () => {
  const trigger = new SilenceTrigger();
  assert.equal(trigger.update({ nowPerf: 3000, lastHeardAt: 1000, isSuspended: true }), false);
  assert.equal(trigger.update({ nowPerf: 9000, lastHeardAt: 1000, isSuspended: true }), false);
  assert.equal(trigger.update({ nowPerf: 9100, lastHeardAt: 1000 }), false);
  assert.equal(trigger.update({ nowPerf: 16000, lastHeardAt: 10000 }), true);
});

test('실시간 발동 임계는 3.5초이고, 평가 정의(5초)는 그대로다', () => {
  assert.equal(SILENCE_TRIGGER_MS, 5000);
  assert.equal(LIVE_SILENCE_TRIGGER_MS, 3500);
  const trigger = new SilenceTrigger({ thresholdMs: LIVE_SILENCE_TRIGGER_MS });
  assert.equal(trigger.update({ nowPerf: 4400, lastHeardAt: 1000 }), false);
  assert.equal(trigger.update({ nowPerf: 4500, lastHeardAt: 1000 }), true);
});

// 카드 영상의 멈춤: 20.2초까지 말소리, 23.7초에 숨소리 한 틱(0.025)이 문턱 0.02 를 넘고, 25.2초부터 다시 말한다.
// 멈춤 구간 바닥 잡음은 0.019 로 문턱 바로 아래다. 렌더러의 100ms 틱을 그대로 흉내 낸다.
const SPEAK_THRESHOLD = 0.02;
function readCardPauseLevel(nowMs) {
  if (nowMs < 20200 || nowMs >= 25200) return 0.04;
  if (nowMs === 23700) return 0.025;
  return 0.019;
}

function simulateFirstFireMs({ thresholdMs }) {
  const trigger = new SilenceTrigger({ thresholdMs });
  trigger.reset({ nowPerf: 17900 });
  let lastHeardAt = 0;
  for (let nowMs = 18000; nowMs <= 27000; nowMs += 100) {
    if (readCardPauseLevel(nowMs) > SPEAK_THRESHOLD) lastHeardAt = nowMs;
    if (trigger.update({ nowPerf: nowMs, lastHeardAt })) return nowMs;
  }
  return null;
}

test('카드 영상의 멈춤에서 실시간 임계(3.5초)는 숨소리 전에 발동하고, 5초 임계는 끝내 발동하지 않는다', () => {
  const liveFireMs = simulateFirstFireMs({ thresholdMs: LIVE_SILENCE_TRIGGER_MS });
  assert.ok(liveFireMs !== null && liveFireMs < 23700, `발동 시각 ${liveFireMs}`);
  assert.equal(simulateFirstFireMs({ thresholdMs: SILENCE_TRIGGER_MS }), null);
});

test('렌더러는 모든 모드에서 실시간 임계로 무음 트리거를 만든다', () => {
  const source = fs.readFileSync(new URL('../src/renderer/app/main.js', import.meta.url), 'utf8');
  assert.match(source, /const silenceTrigger = new SilenceTrigger\(\{ thresholdMs: LIVE_SILENCE_TRIGGER_MS \}\);/);
  assert.doesNotMatch(source, /new SilenceTrigger\(\)/);
});
