import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NarrationMixer } from '../src/renderer/core/audio-renderer/narration-mixer.js';
import { CaptionNarrator } from '../src/renderer/core/audio-renderer/caption-narrator.js';

function createConnectableNode(extra = {}) {
  return { ...extra, connectedList: [], connect(node) { this.connectedList.push(node); } };
}

// 값 바꾸기 예약을 순서대로 적어 두는 가짜 AudioParam. 선형 변화는 끝값에 닿은 것으로 본다.
function createRecordingParam(value) {
  return {
    value,
    eventList: [],
    cancelScheduledValues(time) { this.eventList.push({ type: 'cancel', time }); },
    setValueAtTime(target, time) { this.eventList.push({ type: 'set', value: target, time }); },
    linearRampToValueAtTime(target, time) { this.eventList.push({ type: 'ramp', value: target, time }); this.value = target; },
  };
}

function createFakeAudioContext() {
  const sourceList = [];
  return {
    sourceList,
    state: 'running',
    currentTime: 0,
    destination: { name: 'destination' },
    createAnalyser: () => createConnectableNode({ fftSize: 0 }),
    createGain: () => createConnectableNode({ gain: createRecordingParam(1) }),
    createStereoPanner: () => createConnectableNode({ pan: createRecordingParam(0), channelCount: 2, channelCountMode: 'clamped-max' }),
    createPanner: () => createConnectableNode({
      panningModel: 'equalpower', distanceModel: 'inverse', positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 },
    }),
    createMediaStreamSource: () => createConnectableNode({ disconnect() {} }),
    decodeAudioData: async (buffer) => ({ duration: 2, id: buffer.id }),
    createBufferSource: () => {
      const source = { buffer: null, onended: null, connect() {}, start() {}, stop() {} };
      sourceList.push(source);
      return source;
    },
    resume: async () => {},
    close: async () => {},
  };
}

const fakeStream = { getAudioTracks: () => [] };
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

function startMixer() {
  let audioContext = null;
  const mixer = new NarrationMixer({ createAudioContext: () => { audioContext = createFakeAudioContext(); return audioContext; } });
  mixer.start(fakeStream);
  const [narrationPanner] = mixer.narrationGainNode.connectedList;
  const [meetingPanner] = mixer.duckGainNode.connectedList;
  return { mixer, audioContext, narrationPanner, meetingPanner };
}

const makeEntry = (id) => ({ wavArrayBuffer: { id }, narrationClass: 'deixis', slideLabel: null, text: id });

test('동시 모드: 해설은 오른쪽 채널(SEEON 패널 쪽)에만 나오고, 해설이 없을 때 회의 소리는 가운데(양쪽)에서 들린다', () => {
  const { narrationPanner, meetingPanner } = startMixer();
  // 스테레오 패너를 끝까지(+1) 밀면 왼쪽 채널은 소리가 0 이다.
  assert.equal(narrationPanner.pan.value, 1);
  assert.equal(meetingPanner.pan.value, 0);
  // 스테레오 입력을 그대로 끝까지 밀면 좌우가 한쪽으로 더해져 두 배로 커진다. 1채널로 내려 섞은 뒤 한쪽으로 보낸다.
  for (const panner of [narrationPanner, meetingPanner]) {
    assert.equal(panner.channelCount, 1);
    assert.equal(panner.channelCountMode, 'explicit');
  }
});

test('동시 모드: 해설이 나오는 동안 회의 소리는 0.3초에 걸쳐 왼쪽 채널 끝(-1)으로 옮겨 가고 12dB 줄어든다', async () => {
  const { mixer, audioContext, meetingPanner } = startMixer();
  audioContext.currentTime = 10;
  mixer.queueCaption(makeEntry('a'));
  await flush();
  assert.deepEqual(meetingPanner.pan.eventList, [
    { type: 'cancel', time: 10 }, { type: 'set', value: 0, time: 10 }, { type: 'ramp', value: -1, time: 10.3 },
  ]);
  assert.ok(Math.abs(mixer.duckGainNode.gain.value - 10 ** (-12 / 20)) < 1e-9);
});

test('동시 모드: 해설이 끝나면 회의 소리 크기는 바로 돌아오고, 자리는 1.5초 기다렸다가 0.6초에 걸쳐 가운데로 돌아온다', async () => {
  const { mixer, audioContext, meetingPanner } = startMixer();
  mixer.queueCaption(makeEntry('a'));
  await flush();
  audioContext.currentTime = 20;
  meetingPanner.pan.eventList.length = 0;
  audioContext.sourceList[0].onended();
  await flush();
  assert.deepEqual(meetingPanner.pan.eventList, [
    { type: 'cancel', time: 20 }, { type: 'set', value: -1, time: 20 }, { type: 'set', value: -1, time: 21.5 },
    { type: 'ramp', value: 0, time: 22.1 },
  ]);
  // 감쇠는 해설 중에만 둔다(기다리는 동안 회의 소리를 줄여 두지 않는다).
  assert.equal(mixer.duckGainNode.gain.value, 1);
  assert.equal(mixer.getSicState().isInserting, false);
});

test('동시 모드: 가운데로 돌아가기 전에 다음 해설이 오면 예약을 지우고 다시 왼쪽 끝으로 간다', async () => {
  const { mixer, audioContext, meetingPanner } = startMixer();
  mixer.queueCaption(makeEntry('a'));
  await flush();
  audioContext.currentTime = 20;
  audioContext.sourceList[0].onended();
  await flush();
  audioContext.currentTime = 21;
  meetingPanner.pan.eventList.length = 0;
  mixer.queueCaption(makeEntry('b'));
  await flush();
  assert.deepEqual(meetingPanner.pan.eventList, [
    { type: 'cancel', time: 21 }, { type: 'set', value: 0, time: 21 }, { type: 'ramp', value: -1, time: 21.3 },
  ]);
});

test('교차 모드: 질문 답은 채널을 나누지 않고 오른쪽(SEEON 패널 쪽)에서 들리게만 해 한쪽 귀로도 들린다', () => {
  const narrator = new CaptionNarrator({ getLiveVideo: () => null, createAudioContext: createFakeAudioContext });
  narrator.start(fakeStream);
  assert.equal(narrator.answerPanner.panningModel, 'HRTF');
  assert.equal(narrator.answerPanner.positionX.value, 0.7);
  assert.equal(narrator.answerPanner.connectedList[0], narrator.ttsGainNode);
});
