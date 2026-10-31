import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioMeter } from '../src/renderer/core/trigger/audio-meter.js';

test('sampleLevel 은 그 순간 analyser 표본으로 RMS 를 낸다', () => {
  const meter = new AudioMeter();
  meter.analyser = {
    fftSize: 4,
    getByteTimeDomainData(sampleData) { sampleData.set([128, 192, 64, 128]); },
  };
  assert.equal(meter.sampleLevel(), Math.sqrt((64 ** 2 + 64 ** 2) / 4) / 128);
});

test('측정 중이 아니면(오디오 트랙 없음·정지) sampleLevel 은 null 이다', () => {
  assert.equal(new AudioMeter().sampleLevel(), null);
});
