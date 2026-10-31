import { defaultUiText } from '../i18n/ui-text.js';

// 슬라이드 화면 글자를 읽을 방법. main 의 전사 백엔드(caption-pipeline/config.js SLIDE_TEXT_BACKEND_LIST)와 같은 값이다.
// 읽은 글자는 해설 값 검사·슬라이드 이름표·질문 답에 쓰인다. OCR 이 응답하지 않으면 main 이 VLM 으로 넘긴다.
export const SLIDE_TEXT_BACKEND_OPTION_LIST = ['vlm', 'ocr'];

const SLIDE_TEXT_BACKEND_LABEL_KEY_MAP = {
  vlm: 'slideText.vlm',
  ocr: 'slideText.ocr',
};

// 선택지 이름. t 를 주면 캡션 언어로, 주지 않으면 한국어로 돌려준다.
export function readSlideTextBackendLabel({ backend, t = defaultUiText }) {
  return t(SLIDE_TEXT_BACKEND_LABEL_KEY_MAP[backend]);
}

// 한국어 선택지 이름.
export const SLIDE_TEXT_BACKEND_LABEL_MAP = Object.fromEntries(
  SLIDE_TEXT_BACKEND_OPTION_LIST.map((backend) => [backend, readSlideTextBackendLabel({ backend })]),
);

export const SLIDE_TEXT_BACKEND_STORAGE_KEY = 'seeon.slideTextBackend';

export function isSlideTextBackend(backend) {
  return SLIDE_TEXT_BACKEND_OPTION_LIST.includes(backend);
}

function readStoredBackend({ storage }) {
  try {
    const stored = storage?.getItem(SLIDE_TEXT_BACKEND_STORAGE_KEY);
    return isSlideTextBackend(stored) ? stored : null;
  } catch {
    return null;
  }
}

// 고른 적이 없으면 null 이다. 그때는 main 의 .env 값(SEEON_SLIDE_TEXT_BACKEND)으로 읽는다.
export function createSlideTextBackendStore({ storage }) {
  let backend = readStoredBackend({ storage });
  const listenerList = [];

  function persist() {
    try {
      storage?.setItem(SLIDE_TEXT_BACKEND_STORAGE_KEY, backend);
    } catch (error) {
      console.warn('[slide-text] 화면 글자 읽기 방법 저장 실패(메모리 상태로 계속):', error.message);
    }
  }

  function set(backendNext) {
    if (!isSlideTextBackend(backendNext) || backendNext === backend) return backend;
    backend = backendNext;
    persist();
    for (const listener of listenerList) listener({ backend });
    return backend;
  }

  return {
    get: () => backend,
    set,
    subscribe: (listener) => { listenerList.push(listener); },
  };
}
