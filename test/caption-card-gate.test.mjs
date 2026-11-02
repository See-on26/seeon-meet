import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionCardGate } from '../src/renderer/core/audio-renderer/caption-card-gate.js';
import { QUEUE_DROP_REASON_MAP } from '../src/renderer/core/audio-renderer/narration-queue.js';

// 해설 기록 카드(자막)는 그 해설의 소리가 나기 시작할 때 띄운다.
function createGate() {
  const shownList = [];
  const gate = new CaptionCardGate({ showCard: (card) => shownList.push(card.text) });
  return { gate, shownList };
}

const entryA = { ts: 1000, text: '사장님 최애 간식 젤리, 왕꿈틀이' };
const entryB = { ts: 2000, text: 'A, 3, J, 4가 적힌 카드 네 장' };

test('해설이 나오면 카드를 들고 있다가 그 해설의 소리가 시작될 때 띄운다', () => {
  const { gate, shownList } = createGate();
  gate.hold({ entry: entryA, card: { text: entryA.text } });
  assert.deepEqual(shownList, []);
  assert.equal(gate.release({ entry: { ...entryA, narrationClass: 'deixis' } }), true);
  assert.deepEqual(shownList, [entryA.text]);
  assert.equal(gate.release({ entry: entryA }), false, '한 번 띄운 카드는 다시 띄우지 않는다');
});

test('소리는 재생 순서대로 시작한 것만 띄운다', () => {
  const { gate, shownList } = createGate();
  gate.hold({ entry: entryA, card: { text: entryA.text } });
  gate.hold({ entry: entryB, card: { text: entryB.text } });
  gate.release({ entry: entryB });
  assert.deepEqual(shownList, [entryB.text]);
});

test('TTS 가 실패해 소리 없이 넘어가면 글이라도 보이게 그때 띄운다', () => {
  const { gate, shownList } = createGate();
  gate.hold({ entry: entryA, card: { text: entryA.text } });
  gate.drop({ entry: entryA, reason: QUEUE_DROP_REASON_MAP.ttsFailed });
  assert.deepEqual(shownList, [entryA.text]);
});

test('재생하지 못하고 버린 해설(대기 줄 초과 등)은 띄우지 않는다', () => {
  const { gate, shownList } = createGate();
  gate.hold({ entry: entryA, card: { text: entryA.text } });
  gate.drop({ entry: entryA, reason: QUEUE_DROP_REASON_MAP.delayExceeded });
  assert.equal(gate.release({ entry: entryA }), false);
  assert.deepEqual(shownList, []);
});

test('재생을 멈추면 들고 있던 카드를 모두 버린다', () => {
  const { gate, shownList } = createGate();
  gate.hold({ entry: entryA, card: { text: entryA.text } });
  gate.clear();
  assert.equal(gate.release({ entry: entryA }), false);
  assert.deepEqual(shownList, []);
});
