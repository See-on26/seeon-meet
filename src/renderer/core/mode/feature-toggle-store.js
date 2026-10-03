import { NARRATION_CLASS_MAP } from '../constants.js';

export const FEATURE_KEY_MAP = {
  pageTransition: 'page_transition',
  deixis: 'deixis',
  speechBased: 'speech_based',
  silenceBased: 'silence_based',
  speakerIdentity: 'speaker_identity',
  manualQuestion: 'manual_question',
  meetingSummary: 'meeting_summary',
};

// 순서가 단축키 Ctrl+Shift+1~7 과 설정 패널 순서다.
export const FEATURE_KEY_LIST = [
  FEATURE_KEY_MAP.pageTransition,
  FEATURE_KEY_MAP.deixis,
  FEATURE_KEY_MAP.speechBased,
  FEATURE_KEY_MAP.silenceBased,
  FEATURE_KEY_MAP.speakerIdentity,
  FEATURE_KEY_MAP.manualQuestion,
  FEATURE_KEY_MAP.meetingSummary,
];

export const FEATURE_LABEL_MAP = {
  [FEATURE_KEY_MAP.pageTransition]: '페이지 전환 해설',
  [FEATURE_KEY_MAP.deixis]: '지시 대상 해설',
  [FEATURE_KEY_MAP.speechBased]: '발화 기반 해설',
  [FEATURE_KEY_MAP.silenceBased]: '무발화 해설',
  [FEATURE_KEY_MAP.speakerIdentity]: '화자 안내',
  [FEATURE_KEY_MAP.manualQuestion]: '질문 기능',
  [FEATURE_KEY_MAP.meetingSummary]: '회의 요약',
};

// 기능을 끄면 막을 재생 분류. 회의 요약은 해설이 아니라서 없다.
const NARRATION_CLASS_BY_FEATURE_MAP = {
  [FEATURE_KEY_MAP.pageTransition]: NARRATION_CLASS_MAP.pageTransition,
  [FEATURE_KEY_MAP.deixis]: NARRATION_CLASS_MAP.deixis,
  [FEATURE_KEY_MAP.speechBased]: NARRATION_CLASS_MAP.speechBased,
  [FEATURE_KEY_MAP.silenceBased]: NARRATION_CLASS_MAP.silenceBased,
  [FEATURE_KEY_MAP.speakerIdentity]: NARRATION_CLASS_MAP.speakerIdentity,
  [FEATURE_KEY_MAP.manualQuestion]: NARRATION_CLASS_MAP.userCommand,
};

export const FEATURE_TOGGLE_STORAGE_KEY = 'seeon.featureToggles';

export function readFeatureKeyFromDigit(digit) {
  const index = Number(digit) - 1;
  return Number.isInteger(index) && index >= 0 && index < FEATURE_KEY_LIST.length ? FEATURE_KEY_LIST[index] : null;
}

function readStoredStateMap({ storage }) {
  try {
    const parsed = JSON.parse(storage?.getItem(FEATURE_TOGGLE_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function createFeatureToggleStore({ storage }) {
  const storedMap = readStoredStateMap({ storage });
  const stateMap = {};
  for (const key of FEATURE_KEY_LIST) stateMap[key] = typeof storedMap[key] === 'boolean' ? storedMap[key] : true;
  const listenerList = [];

  function persist() {
    try {
      storage?.setItem(FEATURE_TOGGLE_STORAGE_KEY, JSON.stringify(stateMap));
    } catch (error) {
      console.warn('[toggle] 기능 토글 저장 실패(메모리 상태로 계속):', error.message);
    }
  }

  function isOn(key) {
    return stateMap[key] === true;
  }

  function set(key, isOnNext) {
    if (!FEATURE_KEY_LIST.includes(key) || stateMap[key] === isOnNext) return isOn(key);
    stateMap[key] = Boolean(isOnNext);
    persist();
    for (const listener of listenerList) listener({ key, isOn: stateMap[key] });
    return stateMap[key];
  }

  function isClassOn(narrationClass) {
    const key = Object.keys(NARRATION_CLASS_BY_FEATURE_MAP)
      .find((featureKey) => NARRATION_CLASS_BY_FEATURE_MAP[featureKey] === narrationClass);
    return key ? isOn(key) : true;
  }

  return {
    isOn,
    set,
    toggle: (key) => set(key, !isOn(key)),
    isClassOn,
    subscribe: (listener) => { listenerList.push(listener); },
  };
}

export function listDisabledNarrationClass({ store }) {
  return FEATURE_KEY_LIST
    .filter((key) => NARRATION_CLASS_BY_FEATURE_MAP[key] && !store.isOn(key))
    .map((key) => NARRATION_CLASS_BY_FEATURE_MAP[key]);
}
