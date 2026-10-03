import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SilenceTrigger, evaluateSilencePrecondition, SILENCE_TRIGGER_MS, SILENCE_SKIP_REASON_MAP,
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
