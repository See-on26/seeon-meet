// 회의 음성을 전사할 언어. main 의 ASR 언어(caption-pipeline/config.js ASR_LANGUAGE_LIST)와 같은 값이다.
// auto 는 말하는 조각마다 한국어·영어 중 하나로 전사한다. 마이크 질문 언어는 여기서 바꾸지 않는다.
export const MEETING_LANGUAGE_LIST = ['ko', 'en', 'auto'];

export const DEFAULT_MEETING_LANGUAGE = 'ko';

export const MEETING_LANGUAGE_LABEL_MAP = {
  ko: '한국어',
  en: 'English',
  auto: '자동(한·영)',
};

// 값은 언어 코드 문자열 그대로 저장한다. 다른 화면이 이 키에 직접 써서 다음 캡처의 언어를 정할 수 있다.
export const MEETING_LANGUAGE_STORAGE_KEY = 'seeon.meetingLanguage';

export function isMeetingLanguage(language) {
  return MEETING_LANGUAGE_LIST.includes(language);
}

// 언어는 캡처를 시작할 때 main 에 한 번 넘긴다. 회의 도중에는 바꾸지 않는다.
export function isMeetingLanguageLocked({ isCaptureActive }) {
  return Boolean(isCaptureActive);
}

function readStoredLanguage({ storage }) {
  try {
    const stored = storage?.getItem(MEETING_LANGUAGE_STORAGE_KEY);
    return isMeetingLanguage(stored) ? stored : DEFAULT_MEETING_LANGUAGE;
  } catch {
    return DEFAULT_MEETING_LANGUAGE;
  }
}

export function createMeetingLanguageStore({ storage }) {
  let language = readStoredLanguage({ storage });
  const listenerList = [];

  function persist() {
    try {
      storage?.setItem(MEETING_LANGUAGE_STORAGE_KEY, language);
    } catch (error) {
      console.warn('[language] 회의 언어 저장 실패(메모리 상태로 계속):', error.message);
    }
  }

  function set(languageNext) {
    if (!isMeetingLanguage(languageNext) || languageNext === language) return language;
    language = languageNext;
    persist();
    for (const listener of listenerList) listener({ language });
    return language;
  }

  return {
    get: () => language,
    set,
    subscribe: (listener) => { listenerList.push(listener); },
  };
}
