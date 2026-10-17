// 캡션 언어: 사용자에게 들리는 말(자동 AD·질문 답·고정 문구·TTS·회의 요약)과 앱 화면 글자의 언어.
// main 의 캡션 언어(caption-pipeline/contracts/caption-language.js)와 같은 값이다. 회의 받아쓰기는 늘 자동(한·영)이다.
export const CAPTION_LANGUAGE_LIST = ['ko', 'en'];

export const DEFAULT_CAPTION_LANGUAGE = 'ko';

export const CAPTION_LANGUAGE_LABEL_MAP = {
  ko: '한국어',
  en: 'English',
};

export const CAPTION_LANGUAGE_STORAGE_KEY = 'seeon.captionLanguage';

export function isCaptionLanguage(language) {
  return CAPTION_LANGUAGE_LIST.includes(language);
}

// 언어는 캡처를 시작할 때 main 에 한 번 넘긴다. 회의 도중에는 바꾸지 않는다.
export function isCaptionLanguageLocked({ isCaptureActive }) {
  return Boolean(isCaptureActive);
}

// 고른 언어는 다음 실행에도 남는다. 한국어가 아니면 캡처 시작 때 알린다.
export function describeNonDefaultCaptionLanguage({ language }) {
  if (!isCaptionLanguage(language) || language === DEFAULT_CAPTION_LANGUAGE) return '';
  return `캡션 언어: ${CAPTION_LANGUAGE_LABEL_MAP[language]}`;
}

function readStoredLanguage({ storage }) {
  try {
    const stored = storage?.getItem(CAPTION_LANGUAGE_STORAGE_KEY);
    return isCaptionLanguage(stored) ? stored : DEFAULT_CAPTION_LANGUAGE;
  } catch {
    return DEFAULT_CAPTION_LANGUAGE;
  }
}

export function createCaptionLanguageStore({ storage }) {
  let language = readStoredLanguage({ storage });
  const listenerList = [];

  function persist() {
    try {
      storage?.setItem(CAPTION_LANGUAGE_STORAGE_KEY, language);
    } catch (error) {
      console.warn('[language] 캡션 언어 저장 실패(메모리 상태로 계속):', error.message);
    }
  }

  function set(languageNext) {
    if (!isCaptionLanguage(languageNext) || languageNext === language) return language;
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
