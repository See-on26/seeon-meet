import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NarrationQueue, NARRATION_QUEUE_TTL_MS, QUEUE_DROP_REASON_MAP, readNarrationPriority, shouldInterrupt,
} from '../src/renderer/core/audio-renderer/narration-queue.js';

function createClock(startMs = 0) {
  const clock = { nowMs: startMs };
  clock.now = () => clock.nowMs;
  return clock;
}

function takeTextList(queue) {
  const textList = [];
  for (let { entry } = queue.takeNext(); entry; { entry } = queue.takeNext()) textList.push(entry.text);
  return textList;
}

test('겹친 자동 해설은 페이지 전환 > 지시 > 발화 > 무발화 > 화자 순으로 꺼낸다', () => {
  const queue = new NarrationQueue({ now: createClock().now });
  queue.push({ text: '화자', narrationClass: 'speaker_identity' });
  queue.push({ text: '무발화', narrationClass: 'silence_based' });
  queue.push({ text: '발화', narrationClass: 'speech_based' });
  queue.push({ text: '지시', narrationClass: 'deixis' });
  queue.push({ text: '전환', narrationClass: 'page_transition' });
  assert.deepEqual(takeTextList(queue), ['전환', '지시', '발화', '무발화', '화자']);
});

test('질문 답은 어떤 자동 해설보다 먼저 꺼낸다', () => {
  const queue = new NarrationQueue({ now: createClock().now });
  queue.push({ text: '전환', narrationClass: 'page_transition' });
  queue.push({ text: '답', narrationClass: 'user_command' });
  assert.deepEqual(takeTextList(queue), ['답', '전환']);
});

test('같은 순위면 먼저 들어온 해설부터 꺼낸다', () => {
  const queue = new NarrationQueue({ now: createClock().now });
  queue.push({ text: '지시1', narrationClass: 'deixis' });
  queue.push({ text: '지시2', narrationClass: 'deixis' });
  queue.push({ text: '지시3', narrationClass: 'deixis' });
  assert.deepEqual(takeTextList(queue), ['지시1', '지시2', '지시3']);
});

test('분류가 없는 해설은 main 과 같이 지시 순위로 본다', () => {
  assert.equal(readNarrationPriority({ narrationClass: undefined }), readNarrationPriority({ narrationClass: 'deixis' }));
  assert.equal(readNarrationPriority({ narrationClass: 'unknown' }), readNarrationPriority({ narrationClass: 'deixis' }));
});

test('재생 차례가 된 뒤 8초 넘게 기다린 자동 해설은 버리고 기다린 시간을 남긴다', () => {
  const clock = createClock(1000);
  const queue = new NarrationQueue({ now: clock.now });
  queue.push({ text: '오래된 지시', narrationClass: 'deixis' });
  clock.nowMs += 2000;
  queue.push({ text: '새 발화', narrationClass: 'speech_based' });
  clock.nowMs += NARRATION_QUEUE_TTL_MS - 1000;
  const { entry, droppedList } = queue.takeNext();
  assert.equal(entry.text, '새 발화');
  assert.equal(droppedList.length, 1);
  assert.equal(droppedList[0].entry.text, '오래된 지시');
  assert.equal(droppedList[0].reason, QUEUE_DROP_REASON_MAP.expired);
  assert.equal(droppedList[0].waitedMs, NARRATION_QUEUE_TTL_MS + 1000);
});

test('8초 이하로 기다린 해설은 그대로 꺼낸다', () => {
  const clock = createClock();
  const queue = new NarrationQueue({ now: clock.now });
  queue.push({ text: '지시', narrationClass: 'deixis' });
  clock.nowMs += NARRATION_QUEUE_TTL_MS;
  const { entry, droppedList } = queue.takeNext();
  assert.equal(entry.text, '지시');
  assert.deepEqual(droppedList, []);
});

test('질문 답과 페이지 전환 고지는 오래 기다려도 버리지 않는다', () => {
  const clock = createClock();
  const queue = new NarrationQueue({ now: clock.now });
  queue.push({ text: '답', narrationClass: 'user_command' });
  queue.push({ text: '전환', narrationClass: 'page_transition', slideLabel: '3' });
  clock.nowMs += NARRATION_QUEUE_TTL_MS * 3;
  assert.deepEqual(takeTextList(queue), ['답', '전환']);
});

test('dueAt 이 있으면 대기 줄에 들어온 시각이 아니라 그 시각부터 기다린 시간을 센다', () => {
  const clock = createClock(20000);
  const queue = new NarrationQueue({ now: clock.now });
  queue.push({ text: '보류됐던 지시', narrationClass: 'deixis', dueAt: 20000 - NARRATION_QUEUE_TTL_MS - 1 });
  const { entry, droppedList } = queue.takeNext();
  assert.equal(entry, null);
  assert.equal(droppedList[0].reason, QUEUE_DROP_REASON_MAP.expired);
});

test('전환 고지를 꺼낼 때 그보다 먼저 들어온 다른 슬라이드 해설은 버린다', () => {
  const queue = new NarrationQueue({ now: createClock().now });
  queue.push({ text: '1번 지시', narrationClass: 'deixis', slideLabel: '1' });
  queue.push({ text: '화자', narrationClass: 'speaker_identity', slideLabel: null });
  queue.push({ text: '2번 앞서 들어온 발화', narrationClass: 'speech_based', slideLabel: '2' });
  queue.push({ text: '2번 전환', narrationClass: 'page_transition', slideLabel: '2' });
  queue.push({ text: '3번 지시', narrationClass: 'deixis', slideLabel: '3' });

  const { entry, droppedList } = queue.takeNext();
  assert.equal(entry.text, '2번 전환');
  assert.deepEqual(droppedList.map((drop) => [drop.entry.text, drop.reason]), [
    ['1번 지시', QUEUE_DROP_REASON_MAP.slideChanged],
  ]);
  assert.deepEqual(takeTextList(queue), ['3번 지시', '2번 앞서 들어온 발화', '화자']);
});

test('슬라이드 번호가 숫자와 문자열로 섞여 와도 같은 슬라이드로 본다', () => {
  const queue = new NarrationQueue({ now: createClock().now });
  queue.push({ text: '2번 지시', narrationClass: 'deixis', slideLabel: 2 });
  queue.push({ text: '2번 재방문 고지', narrationClass: 'page_transition', slideLabel: '2' });
  const { entry, droppedList } = queue.takeNext();
  assert.equal(entry.text, '2번 재방문 고지');
  assert.deepEqual(droppedList, []);
});

test('빈 대기 줄은 null 을 돌려주고 clear 는 대기 해설을 모두 비운다', () => {
  const queue = new NarrationQueue({ now: createClock().now });
  assert.equal(queue.takeNext().entry, null);
  queue.push({ text: '지시', narrationClass: 'deixis' });
  assert.equal(queue.size, 1);
  queue.clear();
  assert.equal(queue.size, 0);
  assert.equal(queue.takeNext().entry, null);
});

test('질문 답만 재생 중인 자동 해설을 끊는다', () => {
  const answer = { narrationClass: 'user_command' };
  const transition = { narrationClass: 'page_transition' };
  const deixis = { narrationClass: 'deixis' };
  assert.equal(shouldInterrupt({ currentEntry: deixis, incomingEntry: answer }), true);
  assert.equal(shouldInterrupt({ currentEntry: deixis, incomingEntry: transition }), false);
  assert.equal(shouldInterrupt({ currentEntry: answer, incomingEntry: answer }), false);
  assert.equal(shouldInterrupt({ currentEntry: null, incomingEntry: answer }), false);
});
