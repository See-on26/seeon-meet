import { defaultUiText } from '../i18n/ui-text.js';

// 해설·질문 답을 읽는 빠르기(MeloTTS speed). main 의 읽기 속도(caption-pipeline/contracts/speech-speed.js)와 같은 값이다.
// 캡처를 시작할 때 main 에 한 번 넘겨 TTS 요청에 싣고, 해설 어절 예산(mode-policy.js computeSpeechMsPerWord)도 이 속도를 따른다.
export const SPEECH_SPEED_LIST = [1.4, 1.6, 1.8, 2.0];

export const DEFAULT_SPEECH_SPEED = 2.0;

export const SPEECH_SPEED_STORAGE_KEY = 'seeon.speechSpeed';

export function isSpeechSpeed(speed) {
  return SPEECH_SPEED_LIST.includes(speed);
}

// 속도는 캡처를 시작할 때 main 에 한 번 넘긴다. 회의 도중에는 바꾸지 않는다.
export function isSpeechSpeedLocked({ isCaptureActive }) {
  return Boolean(isCaptureActive);
}

// 선택지 이름. t 를 주면 캡션 언어로, 주지 않으면 한국어로 돌려준다. 2.0 이 "2" 로 읽히지 않게 소수 한 자리로 적는다.
export function readSpeechSpeedLabel({ speed, t = defaultUiText }) {
  const key = speed === DEFAULT_SPEECH_SPEED ? 'speechSpeed.optionDefault' : 'speechSpeed.option';
  return t(key, { speed: speed.toFixed(1) });
}

function readStoredSpeed({ storage }) {
  try {
    const stored = Number(storage?.getItem(SPEECH_SPEED_STORAGE_KEY));
    return isSpeechSpeed(stored) ? stored : DEFAULT_SPEECH_SPEED;
  } catch {
    return DEFAULT_SPEECH_SPEED;
  }
}

export function createSpeechSpeedStore({ storage }) {
  let speed = readStoredSpeed({ storage });
  const listenerList = [];

  function persist() {
    try {
      storage?.setItem(SPEECH_SPEED_STORAGE_KEY, String(speed));
    } catch (error) {
      console.warn('[speech-speed] 읽기 속도 저장 실패(메모리 상태로 계속):', error.message);
    }
  }

  // 선택 상자 값은 글자라 숫자로 바꿔 비교한다.
  function set(speedNext) {
    const value = Number(speedNext);
    if (!isSpeechSpeed(value) || value === speed) return speed;
    speed = value;
    persist();
    for (const listener of listenerList) listener({ speed });
    return speed;
  }

  return {
    get: () => speed,
    set,
    subscribe: (listener) => { listenerList.push(listener); },
  };
}
