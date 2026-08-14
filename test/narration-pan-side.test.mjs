import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NarrationMixer } from '../src/renderer/core/audio-renderer/narration-mixer.js';
import { CaptionNarrator } from '../src/renderer/core/audio-renderer/caption-narrator.js';

function createConnectableNode(extra = {}) {
  return { ...extra, connectedList: [], connect(node) { this.connectedList.push(node); } };
}

function createFakeAudioContext() {
  return {
    state: 'running',
    currentTime: 0,
    destination: { name: 'destination' },
    createAnalyser: () => createConnectableNode({ fftSize: 0 }),
    createGain: () => createConnectableNode({ gain: { value: 1 } }),
    createPanner: () => createConnectableNode({ positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } }),
    createMediaStreamSource: () => createConnectableNode({ disconnect() {} }),
    resume: async () => {},
    close: async () => {},
  };
}

const fakeStream = { getAudioTracks: () => [] };

test('동시 모드: 해설은 오른쪽(SEEON 패널 쪽), 회의 소리는 왼쪽(회의 화면 쪽)에서 들린다', () => {
  const mixer = new NarrationMixer({ createAudioContext: createFakeAudioContext });
  mixer.start(fakeStream);
  const [narrationPanner] = mixer.narrationGainNode.connectedList;
  const [meetingPanner] = mixer.duckGainNode.connectedList;
  assert.ok(narrationPanner.positionX.value > 0, `해설 positionX=${narrationPanner.positionX.value}`);
  assert.ok(meetingPanner.positionX.value < 0, `회의 소리 positionX=${meetingPanner.positionX.value}`);
});

test('질문 답은 모든 모드에서 해설과 같은 오른쪽에서 들린다', () => {
  const narrator = new CaptionNarrator({ getLiveVideo: () => null, createAudioContext: createFakeAudioContext });
  narrator.start(fakeStream);
  assert.ok(narrator.answerPanner.positionX.value > 0, `답 positionX=${narrator.answerPanner.positionX.value}`);
});
