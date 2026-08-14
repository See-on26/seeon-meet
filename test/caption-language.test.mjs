import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import {
  createCaptionLanguageStore, CAPTION_LANGUAGE_LIST, CAPTION_LANGUAGE_LABEL_MAP, DEFAULT_CAPTION_LANGUAGE,
  CAPTION_LANGUAGE_STORAGE_KEY, isCaptionLanguage, isCaptionLanguageLocked, describeNonDefaultCaptionLanguage,
} from '../src/renderer/core/mode/caption-language-store.js';

const require = createRequire(import.meta.url);
const {
  CAPTION_LANGUAGE_LIST: MAIN_CAPTION_LANGUAGE_LIST, DEFAULT_CAPTION_LANGUAGE: MAIN_DEFAULT_CAPTION_LANGUAGE, resolveCaptionLanguage,
} = require('../src/main/caption-pipeline/contracts/caption-language.js');
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
    config: { asrLanguage, questionAsrLanguage: 'auto' },
  });
}

afterEach(() => { mock.restoreAll(); });

// QA N3·기술 스택 점검표 #9: 회의 언어 메뉴를 없애고 받아쓰기는 자동(한·영)으로 고정한다.
// 설정의 언어 메뉴는 캡션 언어(한국어·English) 하나뿐이고, 사용자에게 들리는 말과 화면 글자가 이 언어를 따른다.
test('캡션 언어 허용값은 ko·en 이고 기본은 ko 다 — main 의 캡션 언어와 같다', () => {
  assert.deepEqual(CAPTION_LANGUAGE_LIST, ['ko', 'en']);
  assert.equal(DEFAULT_CAPTION_LANGUAGE, 'ko');
  assert.deepEqual(CAPTION_LANGUAGE_LIST, MAIN_CAPTION_LANGUAGE_LIST);
  assert.equal(DEFAULT_CAPTION_LANGUAGE, MAIN_DEFAULT_CAPTION_LANGUAGE);
  for (const language of ['ko', 'en']) assert.equal(isCaptionLanguage(language), true, language);
  for (const language of ['auto', 'ja', 'EN', '', undefined, null]) assert.equal(isCaptionLanguage(language), false, String(language));
});

test('캡션 언어 저장 키와 화면 이름을 내보낸다', () => {
  assert.equal(CAPTION_LANGUAGE_STORAGE_KEY, 'seeon.captionLanguage');
  assert.deepEqual(CAPTION_LANGUAGE_LABEL_MAP, { ko: '한국어', en: 'English' });
});

test('저장된 값이 없으면 캡션 언어는 ko 로 시작하고, 고른 값은 다음 실행에도 남는다', () => {
  const storage = createMemoryStorage();
  const store = createCaptionLanguageStore({ storage });
  assert.equal(store.get(), 'ko');
  assert.equal(store.set('en'), 'en');
  assert.equal(storage.map.get(CAPTION_LANGUAGE_STORAGE_KEY), 'en');
  assert.equal(createCaptionLanguageStore({ storage }).get(), 'en');
});

test('저장 값이나 바꾸려는 값이 허용값이 아니면 무시한다', () => {
  assert.equal(createCaptionLanguageStore({ storage: createMemoryStorage({ [CAPTION_LANGUAGE_STORAGE_KEY]: 'auto' }) }).get(), 'ko');
  const storage = createMemoryStorage();
  const store = createCaptionLanguageStore({ storage });
  assert.equal(store.set('ja'), 'ko');
  assert.equal(storage.map.has(CAPTION_LANGUAGE_STORAGE_KEY), false);
});

test('저장소가 없거나 읽기·쓰기에 실패해도 메모리 상태로 동작한다', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(createCaptionLanguageStore({ storage: null }).set('en'), 'en');
  const broken = { getItem: () => { throw new Error('read'); }, setItem: () => { throw new Error('write'); } };
  const store = createCaptionLanguageStore({ storage: broken });
  assert.equal(store.get(), 'ko');
  assert.equal(store.set('en'), 'en');
  assert.equal(warn.mock.callCount(), 1);
});

test('캡션 언어가 바뀔 때만 구독자에게 알린다', () => {
  const store = createCaptionLanguageStore({ storage: createMemoryStorage() });
  const changeList = [];
  store.subscribe(({ language }) => changeList.push(language));
  store.set('ko');
  store.set('en');
  store.set('en');
  assert.deepEqual(changeList, ['en']);
});

test('캡션 언어는 회의 캡처 중에는 바꿀 수 없다', () => {
  assert.equal(isCaptionLanguageLocked({ isCaptureActive: true }), true);
  assert.equal(isCaptionLanguageLocked({ isCaptureActive: false }), false);
});

test('main 은 세션 시작에 받은 캡션 언어를 쓰고, 없거나 허용값이 아니면 한국어로 둔다', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(resolveCaptionLanguage('en'), 'en');
  assert.equal(resolveCaptionLanguage(undefined), 'ko');
  assert.equal(warn.mock.callCount(), 0, '옛 호출(값 없음)은 경고하지 않는다');
  assert.equal(resolveCaptionLanguage('auto'), 'ko');
  assert.equal(warn.mock.callCount(), 1);
});

test('세션 기록에 이번 세션의 캡션 언어가 남는다(회의 뒤 요약도 같은 언어로)', () => {
  const sessionStore = createSessionStore();
  sessionStore.startSession({ mode: 'delayed', asrLanguage: 'auto', captionLanguage: 'en', startedAt: 1 });
  assert.equal(sessionStore.endSession({ endedAt: 2 }).captionLanguage, 'en');
  sessionStore.startSession({ mode: 'delayed', startedAt: 3 });
  assert.equal(sessionStore.endSession({ endedAt: 4 }).captionLanguage, 'ko');
});

test('설정 화면에는 캡션 언어 메뉴만 있고, 캡처 시작 때 받아쓰기 언어 대신 캡션 언어를 보낸다', () => {
  const html = fs.readFileSync(new URL('../src/renderer/app/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="captionLanguageSelect"/);
  assert.doesNotMatch(html, /meetingLanguageSelect/);
  const source = fs.readFileSync(new URL('../src/renderer/app/main.js', import.meta.url), 'utf8');
  assert.match(source, /captionLanguage: captionLanguageStore\.get\(\)/);
  assert.doesNotMatch(source, /asrLanguage: /);
  assert.doesNotMatch(source, /meeting-language-store/);
});

test('세션 시작에 회의 언어를 주면 그 언어로 바꾸고 적용된 언어를 돌려준다', () => {
  const session = createSession({ asrLanguage: 'ko' });
  assert.equal(applySessionMeetingLanguage({ asrLanguageSession: session, asrLanguage: 'en' }), 'en');
  assert.equal(session.getMeetingLanguage(), 'en');
  assert.equal(applySessionMeetingLanguage({ asrLanguageSession: session, asrLanguage: 'auto' }), 'auto');
  assert.equal(session.getQuestionLanguage(), 'auto');
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

test('캡처 시작 안내: 캡션 언어가 한국어가 아니면 알릴 문구를, 한국어면 빈 문자열을 준다', () => {
  assert.equal(describeNonDefaultCaptionLanguage({ language: 'ko' }), '');
  assert.equal(describeNonDefaultCaptionLanguage({ language: 'en' }), '캡션 언어: English');
  assert.equal(describeNonDefaultCaptionLanguage({ language: 'xx' }), '');
});
