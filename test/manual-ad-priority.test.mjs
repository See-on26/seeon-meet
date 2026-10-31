import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NarrationQueue, QUEUE_DROP_REASON_MAP, NARRATION_STALE_AFTER_TRIGGER_MS,
} from '../src/renderer/core/audio-renderer/narration-queue.js';
import { NarrationMixer } from '../src/renderer/core/audio-renderer/narration-mixer.js';
import { CaptionNarrator } from '../src/renderer/core/audio-renderer/caption-narrator.js';
import {
  NarrationHoldGate, holdDuringAnswer, MANUAL_ANSWER_HOLD_MAX_MS,
} from '../src/renderer/core/audio-renderer/narration-entry.js';

// QA N4: 수동 AD 가 최우선이다. 수동 AD 가 올 때까지 자동 AD 는 최대 20초 보류하고,
// 트리거에서 너무 멀어진(10초 넘은) 자동 AD 는 의미가 없으니 버린다.
test('기준값: 트리거 뒤 10초 지나면 버리고, 수동 AD 를 기다리는 보류는 최대 20초다', () => {
  assert.equal(NARRATION_STALE_AFTER_TRIGGER_MS, 10000);
  assert.equal(MANUAL_ANSWER_HOLD_MAX_MS, 20000);
});

function createStaleQueue() {
  const playback = { ms: 0 };
  const queue = new NarrationQueue({ now: () => 0, getPlaybackTimeMs: () => playback.ms });
  return { queue, playback };
}

test('재생 차례에 트리거(사건 시각)에서 10초 넘게 지난 자동 해설은 버린다', () => {
  const { queue, playback } = createStaleQueue();
  queue.push({ text: '지시', narrationClass: 'deixis', eventTimeMs: 1000 });
  queue.push({ text: '발화', narrationClass: 'speech_based', eventTimeMs: 2000 });
  playback.ms = 1000 + NARRATION_STALE_AFTER_TRIGGER_MS + 1;
  const { entry, droppedList } = queue.takeNext();
  assert.equal(entry.text, '발화');
  assert.deepEqual(droppedList.map((drop) => [drop.entry.text, drop.reason]), [['지시', QUEUE_DROP_REASON_MAP.stale]]);
});

test('정확히 10초까지는 들려준다', () => {
  const { queue, playback } = createStaleQueue();
  queue.push({ text: '지시', narrationClass: 'deixis', eventTimeMs: 1000 });
  playback.ms = 1000 + NARRATION_STALE_AFTER_TRIGGER_MS;
  assert.equal(queue.takeNext().entry.text, '지시');
});

test('질문 답과 페이지 전환 고지는 트리거 시각으로 버리지 않는다', () => {
  const { queue, playback } = createStaleQueue();
  queue.push({ text: '답', narrationClass: 'user_command', eventTimeMs: 0 });
  queue.push({ text: '전환', narrationClass: 'page_transition', eventTimeMs: 0, slideLabel: '1' });
  playback.ms = NARRATION_STALE_AFTER_TRIGGER_MS * 5;
  const first = queue.takeNext();
  assert.equal(first.entry.text, '답');
  assert.deepEqual(first.droppedList, []);
  assert.equal(queue.takeNext().entry.text, '전환');
});

test('사건 시각이나 재생 위치를 모르면 트리거 기준으로 버리지 않는다', () => {
  const { queue, playback } = createStaleQueue();
  queue.push({ text: '시각 없음', narrationClass: 'deixis' });
  playback.ms = 999999;
  assert.equal(queue.takeNext().entry.text, '시각 없음');
  const unknownPlayback = new NarrationQueue({ now: () => 0, getPlaybackTimeMs: () => null });
  unknownPlayback.push({ text: '지시', narrationClass: 'deixis', eventTimeMs: 0 });
  assert.equal(unknownPlayback.takeNext().entry.text, '지시');
});

function createFakeAudioContext() {
  const sourceList = [];
  const param = (value = 1) => ({ value, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime(target) { this.value = target; } });
  const context = {
    state: 'running', currentTime: 0, destination: {},
    createAnalyser: () => ({ fftSize: 0, connect() {} }),
    createGain: () => ({ gain: param(), connect() {} }),
    createPanner: () => ({ positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 }, connect() {} }),
    createStereoPanner: () => ({ pan: param(0), connect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    decodeAudioData: async (buffer) => ({ duration: 2, id: buffer.id }),
    createBufferSource: () => {
      const source = { buffer: null, onended: null, isStarted: false, connect() {}, start() { this.isStarted = true; }, stop() {} };
      sourceList.push(source);
      return source;
    },
    resume: async () => {}, close: async () => {},
  };
  return { context, sourceList };
}

const flush = () => new Promise((resolve) => { setImmediate(resolve); });
const fakeStream = { getAudioTracks: () => [] };

test('동시·교차 재생기 모두 지금 재생 위치를 받아 트리거에서 멀어진 자동 해설을 버린다', async () => {
  for (const createPlayer of [
    ({ context, playback, dropList }) => new NarrationMixer({
      createAudioContext: () => context, onDrop: (drop) => dropList.push(drop), getPlaybackTimeMs: () => playback.ms,
    }),
    ({ context, playback, dropList }) => new CaptionNarrator({
      getLiveVideo: () => ({ paused: false, volume: 1, playbackRate: 1, pause() {}, play: async () => {} }),
      createAudioContext: () => context, onDrop: (drop) => dropList.push(drop), getPlaybackTimeMs: () => playback.ms,
      isCatchupDelegated: () => true, sleep: () => Promise.resolve(),
    }),
  ]) {
    const { context, sourceList } = createFakeAudioContext();
    const playback = { ms: 30000 };
    const dropList = [];
    const player = createPlayer({ context, playback, dropList });
    player.start(fakeStream);
    player.queueCaption({ wavArrayBuffer: { id: '늦은 지시' }, narrationClass: 'deixis', text: '늦은 지시', eventTimeMs: 1000 });
    player.queueCaption({ wavArrayBuffer: { id: '방금 지시' }, narrationClass: 'deixis', text: '방금 지시', eventTimeMs: 29000 });
    await flush();
    assert.deepEqual(sourceList.filter((source) => source.isStarted).map((source) => source.buffer.id), ['방금 지시']);
    assert.deepEqual(dropList.map((drop) => [drop.entry.text, drop.reason]), [['늦은 지시', QUEUE_DROP_REASON_MAP.stale]]);
    player.stop();
  }
});

function createGate() {
  const deliveredList = [];
  return { gate: new NarrationHoldGate({ deliver: (item) => deliveredList.push(item) }), deliveredList };
}

function createManualWait() {
  let resolveWait = null;
  return { wait: () => new Promise((resolve) => { resolveWait = resolve; }), finishWait: () => resolveWait() };
}

test('질문(입력창·버튼·단축키)을 보내고 답이 올 때까지 자동 해설을 보류했다가 답이 오면 푼다', async () => {
  const { gate, deliveredList } = createGate();
  const { wait } = createManualWait();
  let finishAnswer = null;
  const pending = holdDuringAnswer({ gate, task: () => new Promise((resolve) => { finishAnswer = resolve; }), wait });
  gate.submit({ text: '지시' });
  assert.deepEqual(deliveredList, []);
  finishAnswer();
  await pending;
  assert.deepEqual(deliveredList.map((item) => item.text), ['지시']);
  assert.equal(gate.isHeld, false);
});

test('답이 20초 안에 오지 않으면 보류를 풀어 자동 해설이 계속 막히지 않게 한다', async () => {
  const { gate, deliveredList } = createGate();
  const { wait, finishWait } = createManualWait();
  let waitedMs = null;
  const pending = holdDuringAnswer({
    gate, task: () => new Promise(() => {}), wait: (ms) => { waitedMs = ms; return wait(); },
  });
  gate.submit({ text: '지시' });
  assert.equal(waitedMs, MANUAL_ANSWER_HOLD_MAX_MS);
  finishWait();
  await pending;
  assert.deepEqual(deliveredList.map((item) => item.text), ['지시']);
});

test('답 요청이 실패해도 보류는 푼다', async () => {
  const { gate } = createGate();
  const { wait } = createManualWait();
  await assert.rejects(holdDuringAnswer({ gate, task: async () => { throw new Error('IPC 실패'); }, wait }));
  assert.equal(gate.isHeld, false);
});
