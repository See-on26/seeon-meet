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

test('재생 시작 알림에는 음성 데이터 없이 엔트리·길이·벽시계만 담는다', () => {
  assert.deepEqual(buildPlayStartInfo({ entry: makeEntry({ id: '지시' }), durationSec: 2.5, wallMs: 99 }), {
    entry: { text: '지시', narrationClass: 'deixis', slideLabel: '3', source: 'deixis', ts: 1000, eventTimeMs: 4200 },
    durationMs: 2500,
    wallMs: 99,
  });
});

test('동시 모드: 해설이 실제로 시작될 때 onPlayStart 를 부른다', async () => {
  const { context, sourceList } = createFakeAudioContext();
  const infoList = [];
  const mixer = new NarrationMixer({
    createAudioContext: () => context, onPlayStart: (info) => infoList.push(info), wallNow: () => 5000,
  });
  mixer.start(fakeStream);
  mixer.queueCaption(makeEntry({ id: '지시' }));
  await flush();
  assert.equal(sourceList[0].isStarted, true);
  assert.deepEqual(infoList.map((info) => [info.entry.text, info.durationMs, info.wallMs]), [['지시', 2500, 5020]]);
});

test('교차 모드: 디코딩 중에 끊긴 해설은 알리지 않고 실제로 튼 답만 알린다', async () => {
  const { context } = createFakeAudioContext();
  const infoList = [];
  const narrator = new CaptionNarrator({
    getLiveVideo: createVideo, createAudioContext: () => context, isCatchupDelegated: () => true,
    onPlayStart: (info) => infoList.push(info), wallNow: () => 0,
  });
  narrator.start(fakeStream);
  narrator.queueCaption(makeEntry({ id: '지시' }));
  narrator.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();
  assert.deepEqual(infoList.map((info) => info.entry.text), ['답']);
});

test('알림을 받는 쪽이 실패해도 해설 재생은 계속된다', async () => {
  const { context, sourceList } = createFakeAudioContext();
  const mixer = new NarrationMixer({ createAudioContext: () => context, onPlayStart: () => { throw new Error('수신 실패'); } });
  mixer.start(fakeStream);
  mixer.queueCaption(makeEntry({ id: '첫째' }));
  await flush();
  mixer.queueCaption(makeEntry({ id: '둘째' }));
  await flush();
  assert.equal(sourceList.length, 1, '첫째가 끝나기 전에는 둘째를 시작하지 않는다');
  sourceList[0].onended();
  await flush();
  assert.deepEqual(sourceList.filter((source) => source.isStarted).map((source) => source.buffer.id), ['첫째', '둘째']);
});

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
