import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NarrationMixer } from '../src/renderer/core/audio-renderer/narration-mixer.js';
import { CaptionNarrator } from '../src/renderer/core/audio-renderer/caption-narrator.js';
import { QUEUE_DROP_REASON_MAP } from '../src/renderer/core/audio-renderer/narration-queue.js';

function createAudioParam(value) {
  return {
    value,
    cancelScheduledValues() {},
    setValueAtTime() {},
    linearRampToValueAtTime(target) { this.value = target; },
  };
}

function createFakeAudioContext() {
  const sourceList = [];
  const context = {
    state: 'running',
    currentTime: 0,
    destination: { name: 'destination' },
    createAnalyser: () => ({ fftSize: 0, connect() {} }),
    createGain: () => ({ gain: createAudioParam(1), connect() {} }),
    createPanner: () => ({
      positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 },
      connect() {},
    }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    decodeAudioData: async (buffer) => ({ duration: buffer.durationSec ?? 2, id: buffer.id }),
    createBufferSource: () => {
      const source = {
        buffer: null, onended: null, connectedNode: null, isStarted: false, isStopped: false,
        connect(node) { this.connectedNode = node; },
        start() { this.isStarted = true; },
        stop() { this.isStopped = true; },
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

function makeEntry({ id, narrationClass = 'deixis', slideLabel = null, durationSec = 2 }) {
  return { wavArrayBuffer: { id, durationSec }, narrationClass, slideLabel, text: id };
}

function startedIdList(sourceList) {
  return sourceList.filter((source) => source.isStarted).map((source) => source.buffer.id);
}

function createMixer({ dropList = [] } = {}) {
  const { context, sourceList } = createFakeAudioContext();
  const mixer = new NarrationMixer({ createAudioContext: () => context, onDrop: (drop) => dropList.push(drop) });
  mixer.start(fakeStream);
  return { mixer, context, sourceList, dropList };
}

test('동시 모드: 재생 중에 순위 높은 자동 해설이 와도 끊지 않고 끝난 뒤 순위 순서로 재생한다', async () => {
  const { mixer, sourceList } = createMixer();
  mixer.queueCaption(makeEntry({ id: '화자', narrationClass: 'speaker_identity' }));
  await flush();
  mixer.queueCaption(makeEntry({ id: '무발화', narrationClass: 'silence_based' }));
  mixer.queueCaption(makeEntry({ id: '전환', narrationClass: 'page_transition' }));
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['화자']);
  assert.equal(sourceList[0].isStopped, false);

  sourceList[0].onended();
  await flush();
  sourceList[1].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['화자', '전환', '무발화']);
});

test('동시 모드: 질문 답이 오면 재생 중인 자동 해설을 멈추고 답을 바로 재생한다', async () => {
  const { mixer, sourceList, dropList } = createMixer();
  mixer.queueCaption(makeEntry({ id: '지시' }));
  await flush();
  mixer.queueCaption(makeEntry({ id: '대기 발화', narrationClass: 'speech_based' }));
  mixer.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();

  assert.equal(sourceList[0].isStopped, true);
  assert.deepEqual(startedIdList(sourceList), ['지시', '답']);
  assert.deepEqual(dropList.map((drop) => [drop.entry.text, drop.reason]), [['지시', QUEUE_DROP_REASON_MAP.interrupted]]);

  sourceList[0].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['지시', '답'], '멈춘 해설의 ended 는 다음 재생을 부르지 않는다');

  sourceList[1].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['지시', '답', '대기 발화']);
});

test('동시 모드: 디코딩 중에 끊긴 해설은 시작하지 않는다', async () => {
  const { mixer, sourceList } = createMixer();
  mixer.queueCaption(makeEntry({ id: '지시' }));
  mixer.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['답']);
});

test('동시 모드: 대기 줄이 비면 회의 소리 덕킹을 푼다', async () => {
  const { mixer, sourceList } = createMixer();
  mixer.queueCaption(makeEntry({ id: '지시' }));
  await flush();
  assert.equal(mixer.getSicState().isInserting, true);
  assert.ok(mixer.duckGainNode.gain.value < 0.3);

  sourceList[0].onended();
  await flush();
  assert.equal(mixer.getSicState().isInserting, false);
  assert.equal(mixer.duckGainNode.gain.value, 1.0);
});

test('동시 모드: 8초 넘게 기다린 자동 해설은 재생하지 않고 onDrop 으로 알린다', async () => {
  const { mixer, sourceList, dropList } = createMixer();
  mixer.queueCaption(makeEntry({ id: '지시' }));
  await flush();
  mixer.queueCaption({ ...makeEntry({ id: '오래된 발화', narrationClass: 'speech_based' }), dueAt: performance.now() - 9000 });
  sourceList[0].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['지시']);
  assert.deepEqual(dropList.map((drop) => [drop.entry.text, drop.reason]), [['오래된 발화', QUEUE_DROP_REASON_MAP.expired]]);
});

function createVideo() {
  return {
    paused: false, playbackRate: 1.0, volume: 1.0,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
}

function createNarrator({ isCatchupDelegated = true } = {}) {
  const { context, sourceList } = createFakeAudioContext();
  const video = createVideo();
  const dropList = [];
  const narrator = new CaptionNarrator({
    getLiveVideo: () => video,
    createAudioContext: () => context,
    isCatchupDelegated: () => isCatchupDelegated,
    getRateRange: () => ({ rateMin: 1.5, rateMax: 1.8 }),
    onDrop: (drop) => dropList.push(drop),
  });
  narrator.start(fakeStream);
  return { narrator, context, sourceList, video, dropList };
}

test('교차 모드: 자동 해설은 지금처럼 회의 영상을 멈추고 재생한 뒤 다시 튼다', async () => {
  const { narrator, sourceList, video } = createNarrator();
  narrator.queueCaption(makeEntry({ id: '지시' }));
  await flush();
  assert.equal(video.paused, true);
  assert.equal(video.volume, 1.0);

  sourceList[0].onended();
  await flush();
  assert.equal(video.paused, false);
  assert.equal(narrator.getSicState().isInserting, false);
});

test('교차 모드: 질문 답은 회의 영상을 멈추지 않고 소리만 줄였다가 끝나면 되돌린다', async () => {
  const { narrator, sourceList, video } = createNarrator();
  narrator.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();
  assert.equal(video.paused, false);
  assert.ok(video.volume > 0.2 && video.volume < 0.3, `회의 소리 −12dB, 실제 ${video.volume}`);
  assert.equal(narrator.getSicState().isInserting, true, '답 재생 중에도 해설 메아리 구간으로 본다');
  assert.notEqual(sourceList[0].connectedNode, narrator.ttsGainNode, '답은 왼쪽 패너로 나간다');

  sourceList[0].onended();
  await flush();
  assert.equal(video.volume, 1.0);
  assert.equal(narrator.getSicState().isInserting, false);
});

test('교차 모드: 자동 해설 중 질문 답이 오면 해설을 끊고 영상을 다시 틀어 소리를 줄인 채 답한다', async () => {
  const { narrator, context, sourceList, video, dropList } = createNarrator({ isCatchupDelegated: false });
  narrator.queueCaption(makeEntry({ id: '지시', durationSec: 3 }));
  await flush();
  assert.equal(video.paused, true);

  context.currentTime = 1.02;
  narrator.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();
  assert.equal(sourceList[0].isStopped, true);
  assert.deepEqual(startedIdList(sourceList), ['지시', '답']);
  assert.equal(video.paused, false);
  assert.ok(video.volume < 0.3);
  assert.ok(video.playbackRate > 1.0, '멈췄던 1초를 따라잡는다');
  assert.deepEqual(dropList.map((drop) => [drop.entry.text, drop.reason]), [['지시', QUEUE_DROP_REASON_MAP.interrupted]]);
  narrator.stop();
});

test('교차 모드: 답 뒤에 대기 중인 자동 해설은 소리를 되돌리고 영상을 멈춘 뒤 재생한다', async () => {
  const { narrator, sourceList, video } = createNarrator();
  narrator.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();
  narrator.queueCaption(makeEntry({ id: '지시' }));
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['답']);

  sourceList[0].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['답', '지시']);
  assert.equal(video.volume, 1.0);
  assert.equal(video.paused, true);
});

test('교차 모드: stop 은 줄인 회의 소리를 되돌린다', async () => {
  const { narrator, video } = createNarrator();
  narrator.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();
  narrator.stop();
  assert.equal(video.volume, 1.0);
});
