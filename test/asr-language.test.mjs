import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  readPipelineConfig, ASR_LANGUAGE_LIST, DEFAULT_ASR_LANGUAGE, isAsrLanguage,
} = require('../src/main/caption-pipeline/config.js');
const { createAsrClient, isHallucinatedTranscript } = require('../src/main/caption-pipeline/perception/asr-client.js');
const { createAsrLanguageSession } = require('../src/main/caption-pipeline/perception/asr-language.js');

const ASR_URL = 'http://127.0.0.1:8802/asr';
const originalFetch = globalThis.fetch;
let requestUrlList;

function installAsrFetch(body) {
  globalThis.fetch = async (url) => {
    requestUrlList.push(url);
    return { ok: true, status: 200, json: async () => body };
  };
}

function createFakeAsrClient() {
  const callList = [];
  return {
    callList,
    async transcribeSegment(request) {
      callList.push(request);
      return { text: '말', segmentList: [], hallucinationText: '', language: request.language, languageProbability: null };
    },
  };
}

beforeEach(() => { requestUrlList = []; });
afterEach(() => { globalThis.fetch = originalFetch; mock.restoreAll(); });

test('ASR 언어 허용값은 ko·en·auto 이고 기본은 자동(auto)이다', () => {
  assert.deepEqual(ASR_LANGUAGE_LIST, ['ko', 'en', 'auto']);
  assert.equal(DEFAULT_ASR_LANGUAGE, 'auto');
  for (const language of ['ko', 'en', 'auto']) assert.equal(isAsrLanguage(language), true, language);
  for (const language of ['ja', 'EN', '', undefined, null]) assert.equal(isAsrLanguage(language), false, String(language));
});

test('환경변수가 없으면 회의·질문 ASR 언어 둘 다 자동(auto)이다', () => {
  const config = readPipelineConfig({});
  assert.equal(config.asrLanguage, 'auto');
  assert.equal(config.questionAsrLanguage, 'auto');
});

test('회의와 질문 ASR 언어는 환경변수를 따로 읽는다', () => {
  for (const language of ['ko', 'en', 'auto']) {
    assert.equal(readPipelineConfig({ SEEON_ASR_LANGUAGE: language }).asrLanguage, language);
    assert.equal(readPipelineConfig({ SEEON_QUESTION_ASR_LANGUAGE: language }).questionAsrLanguage, language);
  }
  const config = readPipelineConfig({ SEEON_ASR_LANGUAGE: 'en' });
  assert.equal(config.asrLanguage, 'en');
  assert.equal(config.questionAsrLanguage, 'auto');
});

test('허용하지 않는 ASR 언어는 경고하고 자동(auto)으로 둔다', () => {
  const warn = mock.method(console, 'warn', () => {});
  const config = readPipelineConfig({ SEEON_ASR_LANGUAGE: 'japanese', SEEON_QUESTION_ASR_LANGUAGE: 'EN' });
  assert.equal(config.asrLanguage, 'auto');
  assert.equal(config.questionAsrLanguage, 'auto');
  assert.equal(warn.mock.callCount(), 2);
  assert.match(warn.mock.calls[0].arguments[0], /SEEON_ASR_LANGUAGE/);
  assert.match(warn.mock.calls[1].arguments[0], /SEEON_QUESTION_ASR_LANGUAGE/);
});

test('언어를 주면 ASR 요청 주소에 language 를 붙이고, 없으면 붙이지 않는다', async () => {
  installAsrFetch({ text: '안녕하세요', segmentList: [] });
  const asrClient = createAsrClient({ config: { asrUrl: ASR_URL } });
  await asrClient.transcribeSegment({ webmBuffer: Buffer.from('a'), startTs: 1000, language: 'en' });
  await asrClient.transcribeSegment({ webmBuffer: Buffer.from('a'), startTs: 2000 });
  await asrClient.transcribeSegment({ webmBuffer: Buffer.from('a'), startTs: 3000, language: 'a b&c' });
  assert.deepEqual(requestUrlList, [
    `${ASR_URL}?startTs=1000&language=en`,
    `${ASR_URL}?startTs=2000`,
    `${ASR_URL}?startTs=3000&language=a%20b%26c`,
  ]);
});

test('서버가 준 language·languageProbability 를 그대로 돌려주고, 옛 서버라 없으면 null 이다', async () => {
  const asrClient = createAsrClient({ config: { asrUrl: ASR_URL } });
  installAsrFetch({ text: 'Hello everyone', segmentList: [], language: 'en', languageProbability: 0.93 });
  const detected = await asrClient.transcribeSegment({ webmBuffer: Buffer.from('a'), startTs: 0, language: 'auto' });
  assert.equal(detected.text, 'Hello everyone');
  assert.equal(detected.language, 'en');
  assert.equal(detected.languageProbability, 0.93);

  installAsrFetch({ text: '안녕하세요', segmentList: [] });
  const legacy = await asrClient.transcribeSegment({ webmBuffer: Buffer.from('a'), startTs: 0 });
  assert.equal(legacy.language, null);
  assert.equal(legacy.languageProbability, null);
});

test('영어 환각 문구만 있는 응답은 비우되 언어 정보는 남긴다', async () => {
  installAsrFetch({ text: ' Thanks for watching!', segmentList: [{ startSec: 0, endSec: 1, text: 'Thanks for watching!' }], language: 'en', languageProbability: null });
  const asrClient = createAsrClient({ config: { asrUrl: ASR_URL } });
  const result = await asrClient.transcribeSegment({ webmBuffer: Buffer.from('a'), startTs: 0, language: 'en' });
  assert.equal(result.text, '');
  assert.deepEqual(result.segmentList, []);
  assert.equal(result.hallucinationText, 'Thanks for watching!');
  assert.equal(result.language, 'en');
});

test('Whisper 대표 영어 환각 문구는 대소문자·끝 부호와 상관없이 차단한다', () => {
  for (const text of [
    'Thank you.', 'THANK YOU!', 'Thanks for watching!', 'Thank you for watching.',
    'Please subscribe.', 'Subtitles by the Amara.org community', 'you',
    'Thank you. Thanks for watching!',
  ]) {
    assert.equal(isHallucinatedTranscript({ text }), true, text);
  }
});

test('Thank you 가 들어 있어도 정상 영어 발화는 지우지 않는다', () => {
  for (const text of [
    'Thank you for the update.', 'Thank you. Next slide, please.', 'Thanks, let me share my screen.',
    'Please subscribe to the newsletter on this slide.', 'As you can see, revenue grew 30%.',
  ]) {
    assert.equal(isHallucinatedTranscript({ text }), false, text);
  }
});

test('영어 문구를 더해도 한국어 환각 차단은 그대로다', () => {
  assert.equal(isHallucinatedTranscript({ text: '시청해 주셔서 감사합니다.' }), true);
  assert.equal(isHallucinatedTranscript({ text: '감사합니다. 다음 장 보겠습니다.' }), false);
});

test('회의 음성은 세션 언어, 마이크 질문은 질문 언어로 전사한다', async () => {
  const asrClient = createFakeAsrClient();
  const session = createAsrLanguageSession({ asrClient, config: { asrLanguage: 'en', questionAsrLanguage: 'ko' } });
  const meeting = await session.transcribeMeetingSegment({ webmBuffer: Buffer.from('a'), startTs: 1 });
  const question = await session.transcribeQuestionSegment({ webmBuffer: Buffer.from('b'), startTs: 2 });
  assert.deepEqual(asrClient.callList.map(({ startTs, language }) => ({ startTs, language })), [
    { startTs: 1, language: 'en' },
    { startTs: 2, language: 'ko' },
  ]);
  assert.equal(meeting.requestedLanguage, 'en');
  assert.equal(meeting.text, '말');
  assert.equal(question.requestedLanguage, 'ko');
});

test('setMeetingLanguage 는 허용값이면 회의 언어만 바꾸고 true 를 돌려준다', async () => {
  const asrClient = createFakeAsrClient();
  const session = createAsrLanguageSession({ asrClient, config: { asrLanguage: 'ko', questionAsrLanguage: 'ko' } });
  assert.equal(session.getMeetingLanguage(), 'ko');
  assert.equal(session.setMeetingLanguage('auto'), true);
  assert.equal(session.getMeetingLanguage(), 'auto');
  assert.equal(session.getQuestionLanguage(), 'ko');
  await session.transcribeMeetingSegment({ webmBuffer: Buffer.from('a'), startTs: 1 });
  await session.transcribeQuestionSegment({ webmBuffer: Buffer.from('b'), startTs: 2 });
  assert.deepEqual(asrClient.callList.map(({ language }) => language), ['auto', 'ko']);
});

test('setMeetingLanguage 는 허용하지 않는 값이면 경고하고 바꾸지 않고 false 를 돌려준다', () => {
  const warn = mock.method(console, 'warn', () => {});
  const session = createAsrLanguageSession({
    asrClient: createFakeAsrClient(), config: { asrLanguage: 'en', questionAsrLanguage: 'ko' },
  });
  for (const language of ['ja', 'EN', '', undefined]) {
    assert.equal(session.setMeetingLanguage(language), false, String(language));
  }
  assert.equal(session.getMeetingLanguage(), 'en');
  assert.equal(warn.mock.callCount(), 4);
});

test('응답을 기다리는 동안 회의 언어가 바뀌어도 결과에는 요청한 언어가 남는다', async () => {
  let resolveResponse;
  const asrClient = {
    transcribeSegment: ({ language }) => new Promise((resolve) => {
      resolveResponse = () => resolve({ text: 'hi', segmentList: [], hallucinationText: '', language, languageProbability: 0.9 });
    }),
  };
  const session = createAsrLanguageSession({ asrClient, config: { asrLanguage: 'auto', questionAsrLanguage: 'ko' } });
  const pending = session.transcribeMeetingSegment({ webmBuffer: Buffer.from('a'), startTs: 1 });
  session.setMeetingLanguage('ko');
  resolveResponse();
  const result = await pending;
  assert.equal(result.requestedLanguage, 'auto');
  assert.equal(session.getMeetingLanguage(), 'ko');
});
