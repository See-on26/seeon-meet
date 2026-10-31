import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NarrationAudioPrefetcher, PREFETCH_AHEAD_COUNT, narrationEntryKey,
} from '../src/renderer/core/audio-renderer/narration-audio-prefetcher.js';

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

function createPrefetcher({ failTextSet = new Set() } = {}) {
  const synthesizedList = [];
  const prefetcher = new NarrationAudioPrefetcher({
    synthesize: async (entry) => {
      synthesizedList.push(entry.text);
      if (failTextSet.has(entry.text)) throw new Error('TTS 실패');
      return { id: entry.text };
    },
  });
  return { prefetcher, synthesizedList };
}

const makeEntry = (text, narrationClass = 'deixis', ts = 1) => ({ text, narrationClass, ts });

test('재생 차례가 가까운 자동 해설은 2개까지만 미리 합성한다', async () => {
  assert.equal(PREFETCH_AHEAD_COUNT, 2);
  const { prefetcher, synthesizedList } = createPrefetcher();
  for (const text of ['지시1', '지시2', '지시3']) prefetcher.register(makeEntry(text));
  await flush();
  assert.deepEqual(synthesizedList, ['지시1', '지시2']);
});

test('미리 만든 해설이 재생 차례로 뽑히면 그 소리를 쓰고, 빈 자리에 다음 해설을 미리 만든다', async () => {
  const { prefetcher, synthesizedList } = createPrefetcher();
  for (const text of ['지시1', '지시2', '지시3']) prefetcher.register(makeEntry(text));
  const audio = await prefetcher.take(makeEntry('지시1'));
  await flush();
  assert.deepEqual(audio, { id: '지시1' });
  assert.deepEqual(synthesizedList, ['지시1', '지시2', '지시3']);
});

test('버려진 해설은 자리를 넘기고, 뒤에 기다리던 해설은 합성하지 않았던 것이면 그때 만든다', async () => {
  const { prefetcher, synthesizedList } = createPrefetcher();
  for (const text of ['지시1', '지시2', '지시3', '지시4']) prefetcher.register(makeEntry(text));
  prefetcher.discard(makeEntry('지시4'));
  prefetcher.discard(makeEntry('지시1'));
  await flush();
  assert.deepEqual(synthesizedList, ['지시1', '지시2', '지시3']);
});

test('질문 답은 미리 만들기 자리와 상관없이 바로 합성한다', async () => {
  const { prefetcher, synthesizedList } = createPrefetcher();
  for (const text of ['지시1', '지시2']) prefetcher.register(makeEntry(text));
  prefetcher.register(makeEntry('답', 'user_command'));
  await flush();
  assert.deepEqual(synthesizedList, ['지시1', '지시2', '답']);
  assert.equal(prefetcher.aheadKeyList.length, 2);
});

test('기다리는 해설이 여럿이면 순위가 높은 것부터 미리 만든다', async () => {
  const { prefetcher, synthesizedList } = createPrefetcher();
  prefetcher.register(makeEntry('지시1'));
  prefetcher.register(makeEntry('지시2'));
  prefetcher.register(makeEntry('지시3'));
  prefetcher.register(makeEntry('전환', 'page_transition'));
  prefetcher.discard(makeEntry('지시1'));
  await flush();
  assert.deepEqual(synthesizedList, ['지시1', '지시2', '전환']);
});

test('등록하지 않은 해설도 재생 차례가 되면 그때 합성하고, 합성 실패는 null', async () => {
  const { prefetcher } = createPrefetcher({ failTextSet: new Set(['실패']) });
  assert.deepEqual(await prefetcher.take(makeEntry('바로')), { id: '바로' });
  assert.equal(await prefetcher.take(makeEntry('실패')), null);
});

test('같은 해설은 한 번만 등록되고, 키는 시각·문장으로 정한다', async () => {
  const { prefetcher, synthesizedList } = createPrefetcher();
  prefetcher.register(makeEntry('같음'));
  prefetcher.register({ ...makeEntry('같음'), dueAt: 99 });
  await flush();
  assert.deepEqual(synthesizedList, ['같음']);
  assert.equal(narrationEntryKey({ ts: 5, text: 'a', dueAt: 1 }), narrationEntryKey({ ts: 5, text: 'a' }));
});
