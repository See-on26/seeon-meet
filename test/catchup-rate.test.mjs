import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCatchupRate } from '../src/renderer/core/audio-renderer/delay-buffer.js';
import { getCatchupRateRange } from '../src/renderer/core/mode/mode-policy.js';

// 해설로 밀린 회의 소리를 따라잡는 배속. 남은 지연에 비례해 배속을 낮추면 끝에서 1.1배 꼬리가 길어져(6초 해설 → 20초),
// 정해진 배속으로 따라가다 마지막 약 1초만 1.0배까지 부드럽게 내린다.
const TICK_MS = 250;

function simulateCatchup({ excessMs, rateMin, rateMax }) {
  const rateList = [];
  let remainingMs = excessMs;
  while (remainingMs > 0 && rateList.length < 1000) {
    const rate = computeCatchupRate({ excessMs: remainingMs, rateMin, rateMax });
    rateList.push(rate);
    remainingMs -= (rate - 1) * TICK_MS;
  }
  return { rateList, durationMs: rateList.length * TICK_MS };
}

test('균형 모드는 1.5배로 고정해 따라잡는다', () => {
  assert.deepEqual(getCatchupRateRange({ mode: 'delayed' }), { rateMin: 1.5, rateMax: 1.5 });
  for (const excessMs of [6000, 3000, 1000, 500]) {
    assert.equal(computeCatchupRate({ excessMs, rateMin: 1.5, rateMax: 1.5 }), 1.5, `${excessMs}ms`);
  }
});

test('남은 지연이 거의 없으면 1.0배까지 부드럽게 내리고, 다 메우면 1.0배다', () => {
  const near = computeCatchupRate({ excessMs: 100, rateMin: 1.5, rateMax: 1.5 });
  assert.ok(near > 1.0 && near < 1.5, `끝 무렵은 1.0~1.5배 사이, 실제 ${near}`);
  assert.ok(computeCatchupRate({ excessMs: 50, rateMin: 1.5, rateMax: 1.5 }) < near, '남은 지연이 줄면 배속도 준다');
  assert.equal(computeCatchupRate({ excessMs: 0, rateMin: 1.5, rateMax: 1.5 }), 1.0);
});

test('6초 해설 뒤 균형 모드 따라잡기는 13초 안에 끝나고, 끝에서 배속이 한 번에 크게 떨어지지 않는다', () => {
  const { rateList, durationMs } = simulateCatchup({ excessMs: 6000, rateMin: 1.5, rateMax: 1.5 });
  assert.ok(durationMs <= 13000, `따라잡기 ${durationMs}ms`);
  const slowList = rateList.filter((rate) => rate < 1.2);
  assert.ok(slowList.length * TICK_MS <= 500, `1.2배 미만 꼬리 ${slowList.length * TICK_MS}ms`);
  const stepList = [...rateList, 1.0].slice(1).map((rate, index) => rateList[index] - rate);
  assert.ok(Math.max(...stepList) <= 0.2, `한 번에 떨어지는 배속 최대 ${Math.max(...stepList).toFixed(2)}`);
});

test('성능 모드는 지금 빠르기(1.5~1.8배)를 그대로 쓰고 끝만 부드럽게 내린다', () => {
  assert.equal(computeCatchupRate({ excessMs: 2000, rateMin: 1.5, rateMax: 1.8 }), 1.7);
  assert.equal(computeCatchupRate({ excessMs: 6000, rateMin: 1.5, rateMax: 1.8 }), 1.8);
  const near = computeCatchupRate({ excessMs: 100, rateMin: 1.5, rateMax: 1.8 });
  assert.ok(near < 1.5, `끝 무렵은 1.5배보다 느리다, 실제 ${near}`);
});

test('품질 모드(1.0~1.1배)는 그대로다', () => {
  assert.equal(computeCatchupRate({ excessMs: 5000, rateMin: 1.0, rateMax: 1.1 }), 1.1);
  assert.equal(computeCatchupRate({ excessMs: 500, rateMin: 1.0, rateMax: 1.1 }), 1.05);
});
