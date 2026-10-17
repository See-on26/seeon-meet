import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NarrationMixer, buildPlayStartInfo } from '../src/renderer/core/audio-renderer/narration-mixer.js';
import { CaptionNarrator } from '../src/renderer/core/audio-renderer/caption-narrator.js';
import { LAB_PLAYER_URL, LAB_PLAYER_URL_PATTERN } from '../src/renderer/lab/lab-constants.js';
import { MEET_MEETING_URL_PATTERN } from '../src/renderer/core/constants.js';

function createFakeAudioContext() {
  const sourceList = [];
  const context = {
    state: 'running',
    currentTime: 0,
    destination: {},
    createAnalyser: () => ({ fftSize: 0, connect() {} }),
    createGain: () => ({
      gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime(target) { this.value = target; } },
      connect() {},
    }),
    createPanner: () => ({ positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 }, connect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    decodeAudioData: async (buffer) => ({ duration: buffer.durationSec ?? 2, id: buffer.id }),
    createBufferSource: () => {
      const source = {
        buffer: null, onended: null, isStarted: false, isStopped: false,
        connect() {}, start() { this.isStarted = true; }, stop() { this.isStopped = true; },
      };
      sourceList.push(source);
      return source;
    },
    resume: async () => {},
    close: async () => {},
  };
  return { context, sourceList };
}

const fakeStream = { getAudioTracks: () => [] };
const flush = () => new Promise((resolve) => { setImmediate(resolve); });
const createVideo = () => ({
  paused: false, playbackRate: 1.0, volume: 1.0,
  pause() { this.paused = true; },
  play() { this.paused = false; return Promise.resolve(); },
});

function makeEntry({ id, narrationClass = 'deixis', durationSec = 2.5 }) {
  return {
    wavArrayBuffer: { id, durationSec }, narrationClass, slideLabel: '3', source: 'deixis', text: id,
    ts: 1000, eventTimeMs: 4200, dueAt: 0,
  };
}

test('실험 재생 화면 주소는 실험 패턴에만 맞고 Meet 패턴과 섞이지 않는다', () => {
  assert.match(LAB_PLAYER_URL, LAB_PLAYER_URL_PATTERN);
  assert.doesNotMatch(LAB_PLAYER_URL, MEET_MEETING_URL_PATTERN);
  assert.doesNotMatch('https://meet.google.com/abc-defg-hij', LAB_PLAYER_URL_PATTERN);
});

test('production 화면은 두 재생기에 재생 시작 알림을 넘기고 실험 주소로도 시작할 수 있다', () => {
  const source = fs.readFileSync(new URL('../src/renderer/app/main.js', import.meta.url), 'utf8');
  assert.equal(source.match(/onPlayStart: reportNarrationPlayStart/g)?.length, 2);
  assert.match(source, /window\.seeon\.reportLabNarrationPlayback\?\.\(/);
  assert.match(source, /LAB_PLAYER_URL_PATTERN\.test\(latestMeetUrl\)/);
});
