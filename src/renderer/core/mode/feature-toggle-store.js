import { NARRATION_CLASS_MAP } from '../constants.js';

// 켜고 끄는 기능은 부가 정보 2종(페이지 전환 안내·화자 안내)과 회의 요약이다.
// 정보 공백 해설(지시·발화·무발화)과 질문은 항상 동작한다.
export const FEATURE_KEY_MAP = {
  pageTransition: 'page_transition',
  speakerIdentity: 'speaker_identity',
  meetingSummary: 'meeting_summary',
};

// 순서가 단축키 Ctrl+Shift+1~3 과 설정 패널 순서다.
export const FEATURE_KEY_LIST = [
  FEATURE_KEY_MAP.pageTransition,
  FEATURE_KEY_MAP.speakerIdentity,
  FEATURE_KEY_MAP.meetingSummary,
];

export const FEATURE_LABEL_MAP = {
  [FEATURE_KEY_MAP.pageTransition]: '페이지 전환 안내',
  [FEATURE_KEY_MAP.speakerIdentity]: '화자 안내',
  [FEATURE_KEY_MAP.meetingSummary]: '회의 요약',
};

// 기능을 끄면 막을 재생 분류. 회의 요약은 해설이 아니라서 없다.
const NARRATION_CLASS_BY_FEATURE_MAP = {
  [FEATURE_KEY_MAP.pageTransition]: NARRATION_CLASS_MAP.pageTransition,
  [FEATURE_KEY_MAP.speakerIdentity]: NARRATION_CLASS_MAP.speakerIdentity,
};

// 화자 안내는 끄면 화자 판별 자체를 하지 않으므로, 회의 도중 켜고 끄지 않고 캡처 시작 전에만 정한다.
const CAPTURE_LOCKED_FEATURE_LIST = [FEATURE_KEY_MAP.speakerIdentity];

export function isFeatureLockedDuringCapture(key) {
  return CAPTURE_LOCKED_FEATURE_LIST.includes(key);
}

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

export function listDisabledFeatureLabel({ store }) {
  return FEATURE_KEY_LIST.filter((key) => !store.isOn(key)).map((key) => FEATURE_LABEL_MAP[key]);
}

// 머리줄 배지 문구. 모두 켜져 있으면 빈 문구(배지를 숨긴다).
export function describeDisabledFeatureBadge({ store }) {
  const labelList = listDisabledFeatureLabel({ store });
  return labelList.length ? `꺼진 기능: ${labelList.join(' · ')}` : '';
}

export function listDisabledNarrationClass({ store }) {
  return FEATURE_KEY_LIST
    .filter((key) => NARRATION_CLASS_BY_FEATURE_MAP[key] && !store.isOn(key))
    .map((key) => NARRATION_CLASS_BY_FEATURE_MAP[key]);
}
