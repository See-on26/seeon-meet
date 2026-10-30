import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NarrationMixer, buildPlayStartInfo } from '../src/renderer/core/audio-renderer/narration-mixer.js';
import { CaptionNarrator } from '../src/renderer/core/audio-renderer/caption-narrator.js';

// 재생기가 해설을 실제로 틀기 시작한 순간을 알린다(제품 개발자 모드 흐름 창의 '재생됨'). 실험실도 같은 알림을 받는다.

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
    createStereoPanner: () => ({
      pan: { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime(target) { this.value = target; } },
      connect() {},
    }),
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

// 질문 답은 합성 중인 자동 해설도 끊지 않는다(QA N4). 실제로 튼 순서대로 알린다.
test('교차 모드: 합성 중인 해설도 끊지 않고, 해설 → 답 순서로 실제로 튼 것만 알린다', async () => {
  const { context, sourceList } = createFakeAudioContext();
  const infoList = [];
  const narrator = new CaptionNarrator({
    getLiveVideo: createVideo, createAudioContext: () => context, isCatchupDelegated: () => true,
    onPlayStart: (info) => infoList.push(info), wallNow: () => 0,
  });
  narrator.start(fakeStream);
  narrator.queueCaption(makeEntry({ id: '지시' }));
  narrator.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();
  assert.deepEqual(infoList.map((info) => info.entry.text), ['지시']);
  sourceList[0].onended();
  await flush();
  assert.deepEqual(infoList.map((info) => info.entry.text), ['지시', '답']);
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
