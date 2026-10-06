import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createMeetingLanguageStore, MEETING_LANGUAGE_LIST, MEETING_LANGUAGE_LABEL_MAP, DEFAULT_MEETING_LANGUAGE,
  MEETING_LANGUAGE_STORAGE_KEY, isMeetingLanguage, isMeetingLanguageLocked,
} from '../src/renderer/core/mode/meeting-language-store.js';

const require = createRequire(import.meta.url);
const { ASR_LANGUAGE_LIST, DEFAULT_ASR_LANGUAGE } = require('../src/main/caption-pipeline/config.js');
const {
  createAsrLanguageSession, applySessionMeetingLanguage,
} = require('../src/main/caption-pipeline/perception/asr-language.js');
const { createSessionStore } = require('../src/main/caption-pipeline/instrumentation/session-store.js');

function createMemoryStorage(initialMap = {}) {
  const map = new Map(Object.entries(initialMap));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    map,
  };
}

function createSession({ asrLanguage = 'ko' } = {}) {
  return createAsrLanguageSession({
    asrClient: { transcribeSegment: async () => ({ text: '' }) },
    config: { asrLanguage, questionAsrLanguage: 'ko' },
  });
}

afterEach(() => { mock.restoreAll(); });

test('회의 언어 허용값은 ko·en·auto 이고 기본은 ko 다 — main ASR 언어와 같다', () => {
  assert.deepEqual(MEETING_LANGUAGE_LIST, ['ko', 'en', 'auto']);
  assert.deepEqual(MEETING_LANGUAGE_LIST, ASR_LANGUAGE_LIST);
  assert.equal(DEFAULT_MEETING_LANGUAGE, 'ko');
  assert.equal(DEFAULT_MEETING_LANGUAGE, DEFAULT_ASR_LANGUAGE);
  for (const language of ['ko', 'en', 'auto']) assert.equal(isMeetingLanguage(language), true, language);
  for (const language of ['ja', 'EN', '', undefined, null]) assert.equal(isMeetingLanguage(language), false, String(language));
});

test('회의 언어 저장 키와 화면 이름을 내보낸다', () => {
  assert.equal(MEETING_LANGUAGE_STORAGE_KEY, 'seeon.meetingLanguage');
  assert.deepEqual(MEETING_LANGUAGE_LABEL_MAP, { ko: '한국어', en: 'English', auto: '자동(한·영)' });
});

test('저장된 값이 없으면 회의 언어는 ko 로 시작한다', () => {
  assert.equal(createMeetingLanguageStore({ storage: createMemoryStorage() }).get(), 'ko');
});

test('고른 회의 언어는 언어 코드 그대로 저장되어 다음 실행에도 남는다', () => {
  const storage = createMemoryStorage();
  const store = createMeetingLanguageStore({ storage });
  assert.equal(store.set('en'), 'en');
  assert.equal(storage.map.get(MEETING_LANGUAGE_STORAGE_KEY), 'en');
  assert.equal(createMeetingLanguageStore({ storage }).get(), 'en');

  store.set('auto');
  assert.equal(createMeetingLanguageStore({ storage }).get(), 'auto');
});

test('다른 곳이 같은 키에 써 둔 허용값도 읽는다', () => {
  for (const language of ['ko', 'en', 'auto']) {
    const storage = createMemoryStorage({ [MEETING_LANGUAGE_STORAGE_KEY]: language });
    assert.equal(createMeetingLanguageStore({ storage }).get(), language);
  }
});

test('저장 값이 허용값이 아니면 ko 로 본다', () => {
  for (const stored of ['ja', 'EN', '', '"en"', '{not json', 'undefined']) {
    const storage = createMemoryStorage({ [MEETING_LANGUAGE_STORAGE_KEY]: stored });
    assert.equal(createMeetingLanguageStore({ storage }).get(), 'ko', stored);
  }
});

test('허용하지 않는 언어로 바꾸려 하면 무시하고 저장하지 않는다', () => {
  const storage = createMemoryStorage({ [MEETING_LANGUAGE_STORAGE_KEY]: 'en' });
  const store = createMeetingLanguageStore({ storage });
  assert.equal(store.set('ja'), 'en');
  assert.equal(store.set(undefined), 'en');
  assert.equal(store.get(), 'en');
  assert.equal(storage.map.get(MEETING_LANGUAGE_STORAGE_KEY), 'en');
});

test('저장소가 없거나 읽기·쓰기에 실패해도 메모리 상태로 동작한다', () => {
  const warn = mock.method(console, 'warn', () => {});
  const store = createMeetingLanguageStore({ storage: null });
  assert.equal(store.get(), 'ko');
  assert.equal(store.set('en'), 'en');

  const failing = createMeetingLanguageStore({
    storage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } },
  });
  assert.equal(failing.get(), 'ko');
  assert.equal(failing.set('auto'), 'auto');
  assert.equal(failing.get(), 'auto');
  assert.equal(warn.mock.callCount(), 1);
});

test('회의 언어가 바뀔 때만 구독자에게 알린다', () => {
  const store = createMeetingLanguageStore({ storage: createMemoryStorage() });
  const changeList = [];
  store.subscribe((change) => changeList.push(change));
  store.set('ko');
  store.set('en');
  store.set('en');
  store.set('ja');
  store.set('auto');
  assert.deepEqual(changeList, [{ language: 'en' }, { language: 'auto' }]);
});

test('회의 언어는 회의 캡처 중에는 바꿀 수 없다', () => {
  assert.equal(isMeetingLanguageLocked({ isCaptureActive: true }), true);
  assert.equal(isMeetingLanguageLocked({ isCaptureActive: false }), false);
});

test('세션 시작에 회의 언어를 주면 그 언어로 바꾸고 적용된 언어를 돌려준다', () => {
  const session = createSession({ asrLanguage: 'ko' });
  assert.equal(applySessionMeetingLanguage({ asrLanguageSession: session, asrLanguage: 'en' }), 'en');
  assert.equal(session.getMeetingLanguage(), 'en');
  assert.equal(applySessionMeetingLanguage({ asrLanguageSession: session, asrLanguage: 'auto' }), 'auto');
  assert.equal(session.getQuestionLanguage(), 'ko');
});

test('세션 시작에 회의 언어가 없으면(옛 호출) 지금 회의 언어를 경고 없이 그대로 쓴다', () => {
  const warn = mock.method(console, 'warn', () => {});
  const session = createSession({ asrLanguage: 'en' });
  assert.equal(applySessionMeetingLanguage({ asrLanguageSession: session, asrLanguage: undefined }), 'en');
  assert.equal(applySessionMeetingLanguage({ asrLanguageSession: session, asrLanguage: null }), 'en');
  assert.equal(session.getMeetingLanguage(), 'en');
  assert.equal(warn.mock.callCount(), 0);
});

test('세션 시작의 회의 언어가 허용값이 아니면 경고하고 지금 회의 언어를 그대로 쓴다', () => {
  const warn = mock.method(console, 'warn', () => {});
  const session = createSession({ asrLanguage: 'auto' });
  for (const asrLanguage of ['ja', 'EN', '']) {
    assert.equal(applySessionMeetingLanguage({ asrLanguageSession: session, asrLanguage }), 'auto', asrLanguage);
  }
  assert.equal(session.getMeetingLanguage(), 'auto');
  assert.equal(warn.mock.callCount(), 3);
});

test('세션 기록에 이번 세션의 회의 언어가 모드와 함께 남는다', () => {
  const sessionStore = createSessionStore();
  sessionStore.startSession({ mode: 'realtime_mix', asrLanguage: 'en', startedAt: 1 });
  const session = sessionStore.endSession({ endedAt: 2 });
  assert.equal(session.mode, 'realtime_mix');
  assert.equal(session.asrLanguage, 'en');

  sessionStore.startSession({ mode: 'listening', startedAt: 3 });
  assert.equal(sessionStore.endSession({ endedAt: 4 }).asrLanguage, null);
});
