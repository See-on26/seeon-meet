import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSlideTextStore, SLIDE_TEXT_STATUS_MAP } = require('../src/main/caption-pipeline/orchestrator/slide-text-store.js');
const { createSlideTextAgent } = require('../src/main/caption-pipeline/agents/slide-text-agent.js');

const jpegBuffer = Buffer.from('x');

test('슬라이드마다 한 번만 전사를 시작한다 (major 기준)', async () => {
  let callCount = 0;
  const store = createSlideTextStore({ transcribe: async () => { callCount += 1; return { text: '매출 120억', hasText: true }; } });
  assert.equal(store.ensure({ slideLabel: '3', jpegBuffer }), true);
  assert.equal(store.ensure({ slideLabel: '3-2', jpegBuffer }), false);
  await store.waitFor('3');
  assert.equal(callCount, 1);
  assert.deepEqual(store.get('3-1'), { status: SLIDE_TEXT_STATUS_MAP.ready, text: '매출 120억' });
});

test('요청 전은 missing, 진행 중은 pending', () => {
  const store = createSlideTextStore({ transcribe: () => new Promise(() => {}) });
  assert.equal(store.get('5').status, SLIDE_TEXT_STATUS_MAP.missing);
  store.ensure({ slideLabel: '5', jpegBuffer });
  assert.equal(store.get('5').status, SLIDE_TEXT_STATUS_MAP.pending);
});

test('글자가 없으면 none, 실패하면 failed', async () => {
  const store = createSlideTextStore({
    transcribe: async ({ jpegBuffer: buffer }) => {
      if (buffer.toString() === 'fail') throw new Error('boom');
      return { text: '', hasText: false };
    },
  });
  store.ensure({ slideLabel: '1', jpegBuffer });
  store.ensure({ slideLabel: '2', jpegBuffer: Buffer.from('fail') });
  await store.waitFor('1');
  await store.waitFor('2');
  assert.equal(store.get('1').status, SLIDE_TEXT_STATUS_MAP.none);
  assert.equal(store.get('2').status, SLIDE_TEXT_STATUS_MAP.failed);
});

test('완료를 onSettled 로 알리고 출처·넘긴 이유·줄 수·걸린 시간을 함께 준다', async () => {
  const settledList = [];
  let nowMs = 100;
  const store = createSlideTextStore({
    transcribe: async () => {
      nowMs = 350;
      return { text: 'A', hasText: true, source: 'ocr', fallbackReason: null, lineList: [{ text: 'A' }] };
    },
    onSettled: (event) => settledList.push(event),
    now: () => nowMs,
  });
  store.ensure({ slideLabel: '4', jpegBuffer });
  await store.waitFor('4');
  assert.deepEqual(settledList, [{
    slideLabel: '4', status: SLIDE_TEXT_STATUS_MAP.ready, textLength: 1, errorMessage: '',
    source: 'ocr', fallbackReason: null, lineCount: 1, elapsedMs: 250,
  }]);
});

test('실패를 onSettled 로 알린다(출처 없음)', async () => {
  const settledList = [];
  let nowMs = 0;
  const store = createSlideTextStore({
    transcribe: async () => { nowMs = 40; throw new Error('boom'); },
    onSettled: (event) => settledList.push(event),
    now: () => nowMs,
  });
  store.ensure({ slideLabel: '6', jpegBuffer });
  await store.waitFor('6');
  assert.deepEqual(settledList, [{
    slideLabel: '6', status: SLIDE_TEXT_STATUS_MAP.failed, textLength: 0, errorMessage: 'boom',
    source: null, fallbackReason: null, lineCount: 0, elapsedMs: 40,
  }]);
});

test('빈 라벨은 무시하고, reset 하면 비운다', async () => {
  const store = createSlideTextStore({ transcribe: async () => ({ text: 'A', hasText: true }) });
  assert.equal(store.ensure({ slideLabel: null, jpegBuffer }), false);
  store.ensure({ slideLabel: '7', jpegBuffer });
  await store.waitFor('7');
  store.reset();
  assert.equal(store.get('7').status, SLIDE_TEXT_STATUS_MAP.missing);
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockVlm(content) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
}

test('전사 에이전트: NONE 은 글자 없음', async () => {
  mockVlm('NONE');
  const agent = createSlideTextAgent({ config: { vlmUrl: 'http://x', vlmModel: 'm' } });
  assert.deepEqual(await agent.transcribe({ jpegBuffer }), { text: '', hasText: false, source: 'vlm', fallbackReason: null });
});

test('전사 에이전트: 코드펜스를 벗겨 낸다', async () => {
  mockVlm('```\n2분기 매출 | 120억 원\n```');
  const agent = createSlideTextAgent({ config: { vlmUrl: 'http://x', vlmModel: 'm' } });
  assert.deepEqual(await agent.transcribe({ jpegBuffer }), {
    text: '2분기 매출 | 120억 원', hasText: true, source: 'vlm', fallbackReason: null,
  });
});
