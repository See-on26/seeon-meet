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
    createStereoPanner: () => ({ pan: createAudioParam(0), connect() {} }),
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

// QA: 수동 AD 가 오면 재생 중인 자동 AD 는 끝까지 들려주고, 그다음 수동 AD 를 바로 낸다(끊어서 겹쳐 들리지 않게).
test('동시 모드: 질문 답이 와도 재생 중인 자동 해설을 끊지 않고, 끝나면 대기 중인 자동 해설보다 먼저 답을 재생한다', async () => {
  const { mixer, sourceList, dropList } = createMixer();
  mixer.queueCaption(makeEntry({ id: '지시' }));
  await flush();
  mixer.queueCaption(makeEntry({ id: '대기 발화', narrationClass: 'speech_based' }));
  mixer.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();
  assert.equal(sourceList[0].isStopped, false);
  assert.deepEqual(startedIdList(sourceList), ['지시']);

  sourceList[0].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['지시', '답']);

  sourceList[1].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['지시', '답', '대기 발화']);
  assert.deepEqual(dropList, []);
});

test('동시 모드: 합성·디코딩 중인 자동 해설도 끊지 않고 답은 그 뒤에 재생한다', async () => {
  const { mixer, sourceList } = createMixer();
  mixer.queueCaption(makeEntry({ id: '지시' }));
  mixer.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['지시']);
  sourceList[0].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['지시', '답']);
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
  assert.notEqual(sourceList[0].connectedNode, narrator.ttsGainNode, '답은 오른쪽 패너로 나간다');

  sourceList[0].onended();
  await flush();
  assert.equal(video.volume, 1.0);
  assert.equal(narrator.getSicState().isInserting, false);
});

test('교차 모드: 자동 해설 중 질문 답이 오면 해설을 끝까지 들려준 뒤 영상을 다시 틀어 소리를 줄인 채 답한다', async () => {
  const { narrator, context, sourceList, video, dropList } = createNarrator({ isCatchupDelegated: false });
  narrator.queueCaption(makeEntry({ id: '지시', durationSec: 3 }));
  await flush();
  narrator.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();
  assert.equal(sourceList[0].isStopped, false);
  assert.deepEqual(startedIdList(sourceList), ['지시']);
  assert.equal(video.paused, true);

  context.currentTime = 3.02;
  sourceList[0].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['지시', '답']);
  assert.equal(video.paused, false);
  assert.ok(video.volume < 0.3);
  assert.ok(video.playbackRate > 1.0, '해설로 멈췄던 3초를 따라잡는다');
  assert.deepEqual(dropList, []);
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

test('동시 모드: 한꺼번에 넣은 해설은 첫 항목부터 틀지 않고 우선순위대로 재생한다', async () => {
  const { mixer, sourceList } = createMixer();
  mixer.queueCaptionList([
    makeEntry({ id: '발화', narrationClass: 'speech_based' }),
    makeEntry({ id: '전환', narrationClass: 'page_transition' }),
    makeEntry({ id: '지시' }),
  ]);
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['전환']);
});

test('교차 모드: 한꺼번에 넣은 해설 안에 질문 답이 있어도 재생 중인 자동 해설을 끊지 않고 답을 다음에 재생한다', async () => {
  const { narrator, sourceList } = createNarrator();
  narrator.queueCaption(makeEntry({ id: '지시' }));
  await flush();
  narrator.queueCaptionList([makeEntry({ id: '발화', narrationClass: 'speech_based' }), makeEntry({ id: '답', narrationClass: 'user_command' })]);
  await flush();
  assert.equal(sourceList[0].isStopped, false);
  assert.deepEqual(startedIdList(sourceList), ['지시']);
  sourceList[0].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['지시', '답']);
});

test('교차 모드: 자동 해설로 회의가 멈춘 동안은 대기 시간에 세지 않는다', async () => {
  const clock = { nowMs: 0 };
  const { context, sourceList } = createFakeAudioContext();
  const video = createVideo();
  const dropList = [];
  const narrator = new CaptionNarrator({
    getLiveVideo: () => video, createAudioContext: () => context, isCatchupDelegated: () => true,
    onDrop: (drop) => dropList.push(drop), now: () => clock.nowMs,
  });
  narrator.start(fakeStream);
  narrator.queueCaption({ ...makeEntry({ id: '긴 해설', durationSec: 12 }), dueAt: 0 });
  await flush();
  narrator.queueCaption({ ...makeEntry({ id: '같은 지점 지시' }), dueAt: 0 });
  clock.nowMs = 12000;
  sourceList[0].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['긴 해설', '같은 지점 지시']);
  assert.deepEqual(dropList, []);
});

test('동시 모드: 회의가 멈추지 않으므로 앞 해설을 기다린 시간이 8초를 넘으면 버린다', async () => {
  const clock = { nowMs: 0 };
  const { context, sourceList } = createFakeAudioContext();
  const dropList = [];
  const mixer = new NarrationMixer({ createAudioContext: () => context, onDrop: (drop) => dropList.push(drop), now: () => clock.nowMs });
  mixer.start(fakeStream);
  mixer.queueCaption({ ...makeEntry({ id: '긴 해설', durationSec: 12 }), dueAt: 0 });
  await flush();
  mixer.queueCaption({ ...makeEntry({ id: '같은 지점 지시' }), dueAt: 0 });
  clock.nowMs = 12000;
  sourceList[0].onended();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['긴 해설']);
  assert.equal(dropList[0].reason, QUEUE_DROP_REASON_MAP.expired);
});

test('꺼진 질문 답은 재생 중인 자동 해설을 끊지 않는다', async () => {
  const { context, sourceList } = createFakeAudioContext();
  const mixer = new NarrationMixer({
    createAudioContext: () => context, isEntryEnabled: (entry) => entry.narrationClass !== 'user_command',
  });
  mixer.start(fakeStream);
  mixer.queueCaption(makeEntry({ id: '지시' }));
  await flush();
  mixer.queueCaption(makeEntry({ id: '답', narrationClass: 'user_command' }));
  await flush();
  assert.equal(sourceList[0].isStopped, false);
  assert.deepEqual(startedIdList(sourceList), ['지시']);
});

// Orchestrator → TTS → 전달 Layer: 대기 줄이 재생할 해설을 고른 뒤에만 합성한다.
function createSynthesizingMixer({ failIdSet = new Set() } = {}) {
  const { context, sourceList } = createFakeAudioContext();
  const synthesizedList = [];
  const dropList = [];
  const mixer = new NarrationMixer({
    createAudioContext: () => context,
    onDrop: (drop) => dropList.push(drop),
    prepareAudio: async (entry) => {
      synthesizedList.push(entry.text);
      return failIdSet.has(entry.text) ? null : { id: entry.text, durationSec: 2 };
    },
  });
  mixer.start(fakeStream);
  return { mixer, sourceList, synthesizedList, dropList };
}

function makeTextEntry({ id, narrationClass = 'deixis', slideLabel = null }) {
  return { narrationClass, slideLabel, text: id };
}

test('TTS 는 대기 줄이 재생할 차례로 고른 해설만, 고른 순서대로 합성한다', async () => {
  const { mixer, sourceList, synthesizedList } = createSynthesizingMixer();
  mixer.queueCaptionList([
    makeTextEntry({ id: '지시', narrationClass: 'deixis' }),
    makeTextEntry({ id: '전환', narrationClass: 'page_transition' }),
  ]);
  await flush();
  assert.deepEqual(synthesizedList, ['전환']);
  sourceList[0].onended();
  await flush();
  assert.deepEqual(synthesizedList, ['전환', '지시']);
  assert.deepEqual(startedIdList(sourceList), ['전환', '지시']);
});

test('대기 줄에서 버려진 해설은 합성하지 않는다', async () => {
  const { mixer, sourceList, synthesizedList, dropList } = createSynthesizingMixer();
  mixer.queueCaptionList([
    makeTextEntry({ id: '1번 지시', narrationClass: 'deixis', slideLabel: '1' }),
    makeTextEntry({ id: '2번 전환', narrationClass: 'page_transition', slideLabel: '2' }),
  ]);
  await flush();
  sourceList[0].onended();
  await flush();
  assert.deepEqual(synthesizedList, ['2번 전환']);
  assert.deepEqual(dropList.map((drop) => drop.entry.text), ['1번 지시']);
});

test('합성에 실패한 해설은 소리 없이 건너뛰고 다음 해설로 넘어간다', async () => {
  const { mixer, sourceList, dropList } = createSynthesizingMixer({ failIdSet: new Set(['화자']) });
  mixer.queueCaptionList([
    makeTextEntry({ id: '화자', narrationClass: 'speaker_identity' }),
    makeTextEntry({ id: '무발화', narrationClass: 'silence_based' }),
  ]);
  await flush();
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['무발화']);
  assert.deepEqual(dropList.map((drop) => [drop.entry.text, drop.reason]), [['화자', QUEUE_DROP_REASON_MAP.ttsFailed]]);
});

test('교차 모드 재생기도 고른 해설만 합성하고, 합성 실패는 건너뛴다', async () => {
  const { context, sourceList } = createFakeAudioContext();
  const synthesizedList = [];
  const dropList = [];
  const narrator = new CaptionNarrator({
    getLiveVideo: () => null, createAudioContext: () => context, onDrop: (drop) => dropList.push(drop),
    prepareAudio: async (entry) => {
      synthesizedList.push(entry.text);
      return entry.text === '실패' ? null : { id: entry.text, durationSec: 1 };
    },
  });
  narrator.start(fakeStream);
  narrator.queueCaptionList([
    makeTextEntry({ id: '실패', narrationClass: 'page_transition' }),
    makeTextEntry({ id: '발화', narrationClass: 'speech_based' }),
  ]);
  await flush();
  await flush();
  assert.deepEqual(synthesizedList, ['실패', '발화']);
  assert.deepEqual(startedIdList(sourceList), ['발화']);
  assert.equal(dropList[0].reason, QUEUE_DROP_REASON_MAP.ttsFailed);
});

test('재생을 멈추면 대기 줄에 남은 해설과 합성 중이던 해설을 듣지 못한 것으로 알린다', async () => {
  let resolveSynthesis = null;
  const { context } = createFakeAudioContext();
  const dropList = [];
  const mixer = new NarrationMixer({
    createAudioContext: () => context, onDrop: (drop) => dropList.push(drop),
    prepareAudio: () => new Promise((resolve) => { resolveSynthesis = resolve; }),
  });
  mixer.start(fakeStream);
  mixer.queueCaptionList([makeTextEntry({ id: '합성 중' }), makeTextEntry({ id: '대기' })]);
  await flush();
  mixer.stop();
  resolveSynthesis({ id: '합성 중', durationSec: 1 });
  await flush();
  assert.deepEqual(dropList.map((drop) => [drop.entry.text, drop.reason]).sort(), [
    ['대기', QUEUE_DROP_REASON_MAP.stopped], ['합성 중', QUEUE_DROP_REASON_MAP.stopped],
  ]);
});

test('재생기가 아직 켜지지 않았을 때 들어온 해설도 듣지 못한 것으로 알린다', () => {
  const dropList = [];
  const narrator = new CaptionNarrator({ getLiveVideo: () => null, onDrop: (drop) => dropList.push(drop) });
  narrator.queueCaptionList([makeTextEntry({ id: '늦게 옴' })]);
  assert.deepEqual(dropList.map((drop) => [drop.entry.text, drop.reason]), [['늦게 옴', QUEUE_DROP_REASON_MAP.stopped]]);
});

test('재생 중이던 해설은 멈춰도 들은 것으로 본다(대기 줄 것만 알린다)', async () => {
  const { mixer, sourceList, dropList } = createSynthesizingMixer();
  mixer.queueCaptionList([makeTextEntry({ id: '재생 중' }), makeTextEntry({ id: '대기' })]);
  await flush();
  assert.deepEqual(startedIdList(sourceList), ['재생 중']);
  mixer.stop();
  assert.deepEqual(dropList.map((drop) => drop.entry.text), ['대기']);
});
