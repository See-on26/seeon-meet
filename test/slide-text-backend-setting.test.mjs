import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createSlideTextBackendStore, SLIDE_TEXT_BACKEND_OPTION_LIST, SLIDE_TEXT_BACKEND_LABEL_MAP, SLIDE_TEXT_BACKEND_STORAGE_KEY,
} from '../src/renderer/core/mode/slide-text-backend-store.js';

const require = createRequire(import.meta.url);
const { resolveSlideTextBackend, SLIDE_TEXT_BACKEND_LIST } = require('../src/main/caption-pipeline/config.js');
const { createSlideTextAgent, SLIDE_TEXT_SOURCE_MAP } = require('../src/main/caption-pipeline/agents/slide-text-agent.js');

function createMemoryStorage(initialMap = {}) {
  const map = new Map(Object.entries(initialMap));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    map,
  };
}

test('설정 화면의 선택지는 main 이 받는 전사 백엔드(vlm·ocr)와 같고 이름표가 있다', () => {
  assert.deepEqual(SLIDE_TEXT_BACKEND_OPTION_LIST, SLIDE_TEXT_BACKEND_LIST);
  for (const backend of SLIDE_TEXT_BACKEND_OPTION_LIST) assert.ok(SLIDE_TEXT_BACKEND_LABEL_MAP[backend], backend);
});

// 고른 적이 없으면 null 이다 — 이때 화면은 .env 기본값을 보여 주고, main 은 .env 값으로 읽는다.
test('고른 적이 없으면 null, 고르면 다음 실행에도 남고, 모르는 값은 무시한다', () => {
  const storage = createMemoryStorage();
  const store = createSlideTextBackendStore({ storage });
  assert.equal(store.get(), null);
  assert.equal(store.set('ocr'), 'ocr');
  assert.equal(storage.map.get(SLIDE_TEXT_BACKEND_STORAGE_KEY), 'ocr');
  assert.equal(createSlideTextBackendStore({ storage }).get(), 'ocr');
  assert.equal(store.set('tesseract'), 'ocr');
  assert.equal(createSlideTextBackendStore({ storage: createMemoryStorage({ [SLIDE_TEXT_BACKEND_STORAGE_KEY]: 'x' }) }).get(), null);
});

test('바뀌면 구독자에게 알린다', () => {
  const store = createSlideTextBackendStore({ storage: createMemoryStorage() });
  const changeList = [];
  store.subscribe(({ backend }) => changeList.push(backend));
  store.set('ocr');
  store.set('ocr');
  store.set('vlm');
  assert.deepEqual(changeList, ['ocr', 'vlm']);
});

test('main 은 회의를 시작할 때 화면에서 고른 값을 쓰고, 없거나 모르는 값이면 .env 값을 쓴다', () => {
  assert.equal(resolveSlideTextBackend({ requested: 'ocr', fallback: 'vlm' }), 'ocr');
  assert.equal(resolveSlideTextBackend({ requested: 'vlm', fallback: 'ocr' }), 'vlm');
  assert.equal(resolveSlideTextBackend({ requested: null, fallback: 'ocr' }), 'ocr');
  assert.equal(resolveSlideTextBackend({ requested: undefined, fallback: 'vlm' }), 'vlm');
  assert.equal(resolveSlideTextBackend({ requested: 'paddle', fallback: 'vlm' }), 'vlm');
});

test('슬라이드 전사는 앱 시작 때 값이 아니라 지금 회의의 백엔드로 읽는다', async () => {
  let backend = 'vlm';
  let ocrCallCount = 0;
  const ocrClient = {
    recognize: async () => {
      ocrCallCount += 1;
      return { lineList: [{ text: '79개 RSU 설치' }], meanScore: 0.95, verticalBoxRatio: 0 };
    },
  };
  const agent = createSlideTextAgent({ config: { slideTextBackend: 'vlm' }, ocrClient, getBackend: () => backend });
  backend = 'ocr';
  const result = await agent.transcribe({ jpegBuffer: Buffer.from('x') });
  assert.equal(result.source, SLIDE_TEXT_SOURCE_MAP.ocr);
  assert.equal(result.text, '79개 RSU 설치');
  assert.equal(ocrCallCount, 1);
});
