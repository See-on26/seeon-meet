import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createTtsClient, sanitizeForSpeech, sanitizeMultilineForSpeech, TTS_LANGUAGE_MAP,
} = require('../src/main/caption-pipeline/output/tts-client.js');

// 캡션 언어가 English 면 TTS 서버가 영어 MeloTTS 로 읽도록 언어를 함께 보낸다(서버: language KR·EN, 빠지면 KR).
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch() {
  const bodyList = [];
  globalThis.fetch = async (_url, option) => {
    bodyList.push(JSON.parse(option.body));
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4), text: async () => '' };
  };
  return bodyList;
}

test('캡션 언어를 서버 언어 코드로 보낸다(ko→KR, en→EN, 모르면 KR)', async () => {
  assert.deepEqual(TTS_LANGUAGE_MAP, { ko: 'KR', en: 'EN' });
  const bodyList = mockFetch();
  const client = createTtsClient({ config: { ttsUrl: 'http://tts', ttsLongUrl: 'http://tts-long' } });
  await client.synthesize({ text: '안녕', language: 'ko' });
  await client.synthesize({ text: 'Hello', language: 'en' });
  await client.synthesize({ text: '기본' });
  await client.synthesizeLong({ text: 'Summary', language: 'en' });
  assert.deepEqual(bodyList.map((body) => body.language), ['KR', 'EN', 'KR', 'EN']);
});

test('기호 읽기: 한국어는 지금처럼, 영어는 영어 낱말로 바꾼다', () => {
  assert.equal(sanitizeForSpeech({ text: 'Q&A = $30' }), 'Q앤드A 는 30달러');
  assert.equal(sanitizeForSpeech({ text: 'Q&A = $30', language: 'ko' }), 'Q앤드A 는 30달러');
  assert.equal(sanitizeForSpeech({ text: 'Q&A = $30', language: 'en' }), 'Q and A equals 30 dollars');
  assert.equal(sanitizeMultilineForSpeech({ text: 'R&D\n$5', language: 'en' }), 'R and D\n5 dollars');
});

test('파이프라인 TTS 와 회의 요약 음성은 세션 캡션 언어로 읽는다', () => {
  const source = fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');
  assert.match(source, /ttsClient\.synthesize\(\{ text, language: getCaptionLanguage\(\) \}\)/);
});
