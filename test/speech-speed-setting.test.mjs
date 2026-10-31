import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  createSpeechSpeedStore, SPEECH_SPEED_LIST, DEFAULT_SPEECH_SPEED, SPEECH_SPEED_STORAGE_KEY, isSpeechSpeedLocked,
  readSpeechSpeedLabel,
} from '../src/renderer/core/mode/speech-speed-store.js';
import {
  computeSpeechMsPerWord, computeWordCountFromDurationMs, computeSpeechDurationMs, computeWordBudget, computeSilenceWordBudget,
  MODE_MAP, REFERENCE_SPEECH_SPEED,
} from '../src/renderer/core/mode/mode-policy.js';

const require = createRequire(import.meta.url);
const {
  SPEECH_SPEED_LIST: MAIN_SPEECH_SPEED_LIST, DEFAULT_SPEECH_SPEED: MAIN_DEFAULT_SPEECH_SPEED, resolveSpeechSpeed,
} = require('../src/main/caption-pipeline/contracts/speech-speed.js');
const { createTtsClient } = require('../src/main/caption-pipeline/output/tts-client.js');

function createMemoryStorage(initialMap = {}) {
  const map = new Map(Object.entries(initialMap));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    map,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('읽기 속도 선택지는 1.4·1.6·1.8·2.0 이고 기본은 2.0(그전 서버 고정값)이다. main 과 같은 값이다', () => {
  assert.deepEqual(SPEECH_SPEED_LIST, [1.4, 1.6, 1.8, 2.0]);
  assert.equal(DEFAULT_SPEECH_SPEED, 2.0);
  assert.deepEqual(SPEECH_SPEED_LIST, MAIN_SPEECH_SPEED_LIST);
  assert.equal(DEFAULT_SPEECH_SPEED, MAIN_DEFAULT_SPEECH_SPEED);
});

test('고른 속도는 다음 실행에도 남고, 모르는 값은 무시하며, 바뀔 때만 구독자에게 알린다', () => {
  const storage = createMemoryStorage();
  const store = createSpeechSpeedStore({ storage });
  const changeList = [];
  store.subscribe(({ speed }) => changeList.push(speed));
  assert.equal(store.get(), 2.0);
  assert.equal(store.set(1.8), 1.8);
  assert.equal(store.set('1.6'), 1.6);
  assert.equal(store.set(1.6), 1.6);
  assert.equal(store.set(2.5), 1.6);
  assert.equal(storage.map.get(SPEECH_SPEED_STORAGE_KEY), '1.6');
  assert.equal(createSpeechSpeedStore({ storage }).get(), 1.6);
  assert.equal(createSpeechSpeedStore({ storage: createMemoryStorage({ [SPEECH_SPEED_STORAGE_KEY]: 'fast' }) }).get(), 2.0);
  assert.deepEqual(changeList, [1.8, 1.6]);
});

test('회의 캡처 중에는 잠기고, 선택지 이름은 화면 언어로 읽는다', () => {
  assert.equal(isSpeechSpeedLocked({ isCaptureActive: true }), true);
  assert.equal(isSpeechSpeedLocked({ isCaptureActive: false }), false);
  assert.equal(readSpeechSpeedLabel({ speed: 1.4 }), '1.4배');
  assert.equal(readSpeechSpeedLabel({ speed: 2.0 }), '2.0배 (기본)');
});

test('main 은 회의를 시작할 때 받은 속도를 쓰고, 없거나 모르는 값이면 기본 속도를 쓴다', () => {
  assert.equal(resolveSpeechSpeed(1.6), 1.6);
  assert.equal(resolveSpeechSpeed(undefined), 2.0);
  assert.equal(resolveSpeechSpeed(null), 2.0);
  assert.equal(resolveSpeechSpeed(3), 2.0);
});

test('TTS 요청에 읽기 속도를 함께 보내고, 속도가 없으면 보내지 않는다(서버 기본값)', async () => {
  const bodyList = [];
  globalThis.fetch = async (_url, option) => {
    bodyList.push(JSON.parse(option.body));
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4), text: async () => '' };
  };
  const client = createTtsClient({ config: { ttsUrl: 'http://tts', ttsLongUrl: 'http://tts-long' } });
  await client.synthesize({ text: '안녕', language: 'ko', speed: 1.4 });
  await client.synthesize({ text: '안녕', language: 'ko' });
  assert.equal(bodyList[0].speed, 1.4);
  assert.equal('speed' in bodyList[1], false);
});

test('파이프라인 TTS 는 세션 캡션 언어와 세션 읽기 속도로 읽는다', () => {
  const source = fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');
  assert.match(source, /ttsClient\.synthesize\(\{ text, language: getCaptionLanguage\(\), speed: getSpeechSpeed\(\) \}\)/);
});

// 어절당 0.45초는 MeloTTS speed 2.0 으로 잰 값이다.
test('어절당 발화 시간은 읽기 속도에 반비례한다. 속도를 모르면 지금 값(0.45초)이다', () => {
  assert.equal(REFERENCE_SPEECH_SPEED, 2.0);
  assert.equal(computeSpeechMsPerWord({}), 450);
  assert.equal(computeSpeechMsPerWord({ speechSpeed: 2.0 }), 450);
  assert.equal(computeSpeechMsPerWord({ speechSpeed: 1.4 }), 643);
  assert.equal(computeSpeechMsPerWord({ speechSpeed: 1.8 }), 500);
  assert.equal(computeSpeechDurationMs({ wordCount: 10, speechSpeed: 1.4 }), 6430);
  assert.equal(computeWordCountFromDurationMs({ durationMs: 6000, speechSpeed: 1.4 }), 9);
  assert.equal(computeWordCountFromDurationMs({ durationMs: 6000 }), 13);
});

test('느리게 읽으면 시간이 빠듯한 모드에서 해설 어절 상한이 줄어든다', () => {
  const fast = computeWordBudget({ mode: MODE_MAP.realtimeMix, narrationType: 'visual_description', subKind: 'reaction' });
  const slow = computeWordBudget({ mode: MODE_MAP.realtimeMix, narrationType: 'visual_description', subKind: 'reaction', speechSpeed: 1.4 });
  assert.ok(slow.maxWordCount < fast.maxWordCount, `${slow.maxWordCount} < ${fast.maxWordCount}`);
  const silenceFast = computeSilenceWordBudget({ mode: MODE_MAP.realtimeMix });
  const silenceSlow = computeSilenceWordBudget({ mode: MODE_MAP.realtimeMix, speechSpeed: 1.4 });
  assert.ok(silenceSlow.maxWordCount <= silenceFast.maxWordCount);
});
