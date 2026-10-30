import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DelayBuffer, MIN_HEADROOM_MS } from '../src/renderer/core/audio-renderer/delay-buffer.js';

// 지연 재생은 MediaRecorder 조각(0.2초)을 MSE 로 받아 튼다. 받아 둔 소리가 0.3초뿐이면 따라잡기 배속(1.5배)이
// 버퍼 끝에 닿아 Chromium 이 3초가량 멈춘다(성능 모드 실측 67초에 7번). 성능 모드도 1초는 남겨 둔다.
function createBuffer({ targetDelayMs, liveTimeMs, playheadMs }) {
  const clock = { liveTimeMs, playheadMs };
  const video = {
    paused: true, playbackRate: 1.0, playCount: 0,
    play() { this.paused = false; this.playCount += 1; return Promise.resolve(); },
    pause() { this.paused = true; },
  };
  const source = {
    start: () => video, stop() {}, isReady: () => true,
    getLiveTimeMs: () => clock.liveTimeMs, getPlayheadMs: () => clock.playheadMs,
  };
  const buffer = new DelayBuffer({
    source, targetDelayMs, rateMin: 1.5, rateMax: 1.8, setTimer: () => 1, clearTimer: () => {},
  });
  buffer.start();
  return { buffer, video, clock };
}

test('지연 0 인 성능 모드도 받아 둔 소리가 1초가 될 때까지 재생을 시작하지 않는다', () => {
  assert.equal(MIN_HEADROOM_MS, 1000);
  const { buffer, video, clock } = createBuffer({ targetDelayMs: 0, liveTimeMs: 900, playheadMs: 0 });
  assert.equal(video.playCount, 0);
  assert.equal(buffer.isBuffering, true);

  clock.liveTimeMs = 1000;
  buffer.tick();
  assert.equal(video.playCount, 1);
  assert.equal(buffer.isBuffering, false);
});

test('성능 모드 따라잡기는 받아 둔 소리가 1초로 줄면 멈추고, 그보다 많을 때만 빨리 튼다', () => {
  const { buffer, video, clock } = createBuffer({ targetDelayMs: 0, liveTimeMs: 1000, playheadMs: 0 });
  clock.liveTimeMs = 3000;
  clock.playheadMs = 2000;
  buffer.tick();
  assert.equal(video.playbackRate, 1.0);

  clock.liveTimeMs = 3500;
  buffer.tick();
  assert.ok(video.playbackRate >= 1.5, `0.5초 넘게 밀렸으면 따라잡는다, 실제 ${video.playbackRate}`);
});

test('품질·균형처럼 목표 지연이 1초보다 길면 그 목표를 그대로 쓴다', () => {
  const { buffer } = createBuffer({ targetDelayMs: 10000, liveTimeMs: 0, playheadMs: 0 });
  assert.equal(buffer.effectiveTargetMs, 10000);
});
