import { NARRATION_CLASS_MAP } from '../constants.js';
import { defaultUiText } from '../i18n/ui-text.js';

// 켜고 끄는 기능은 부가 정보 2종(페이지 전환 안내·화자 안내)과 회의 요약이다.
// 정보 공백 해설(지시·발화·무발화)과 질문은 항상 동작한다.
export const FEATURE_KEY_MAP = {
  pageTransition: 'page_transition',
  speakerIdentity: 'speaker_identity',
  meetingSummary: 'meeting_summary',
};

// 순서가 설정 패널 순서다.
export const FEATURE_KEY_LIST = [
  FEATURE_KEY_MAP.pageTransition,
  FEATURE_KEY_MAP.speakerIdentity,
  FEATURE_KEY_MAP.meetingSummary,
];

const FEATURE_LABEL_KEY_MAP = {
  [FEATURE_KEY_MAP.pageTransition]: 'feature.pageTransition',
  [FEATURE_KEY_MAP.speakerIdentity]: 'feature.speakerIdentity',
  [FEATURE_KEY_MAP.meetingSummary]: 'feature.meetingSummary',
};

// 화면에 보이는 기능 이름. t 를 주면 캡션 언어로, 주지 않으면 한국어로 돌려준다.
export function readFeatureLabel({ key, t = defaultUiText }) {
  return t(FEATURE_LABEL_KEY_MAP[key]);
}

// 한국어 기능 이름(개발용 기록에 쓴다).
export const FEATURE_LABEL_MAP = Object.fromEntries(FEATURE_KEY_LIST.map((key) => [key, readFeatureLabel({ key })]));

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

// 단축키는 화면 표시(text)와 스크린리더가 읽을 말(spoken)을 함께 둔다. 글자 키는 맥도 Control 이다.
export const FEATURE_SHORTCUT_MAP = {
  [FEATURE_KEY_MAP.pageTransition]: { text: 'Ctrl+Q', spoken: 'Control Q' },
  [FEATURE_KEY_MAP.speakerIdentity]: { text: 'Ctrl+W', spoken: 'Control W' },
  [FEATURE_KEY_MAP.meetingSummary]: { text: 'Ctrl+0', spoken: 'Control 0' },
};

// 한글 입력 상태에서도 같도록 자판 위치(KeyboardEvent.code)로 읽는다. main 단축키(shortcut.js)와 같은 짝이다.
const FEATURE_KEY_BY_CODE_MAP = {
  KeyQ: FEATURE_KEY_MAP.pageTransition,
  KeyW: FEATURE_KEY_MAP.speakerIdentity,
};

export function readFeatureKeyFromCode(code) {
  return FEATURE_KEY_BY_CODE_MAP[code] || null;
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

export function listDisabledFeatureLabel({ store, t = defaultUiText }) {
  return FEATURE_KEY_LIST.filter((key) => !store.isOn(key)).map((key) => readFeatureLabel({ key, t }));
}

// 머리줄 배지 문구. 모두 켜져 있으면 빈 문구(배지를 숨긴다).
export function describeDisabledFeatureBadge({ store, t = defaultUiText }) {
  const labelList = listDisabledFeatureLabel({ store, t });
  return labelList.length ? t('feature.offBadge', { labelList: labelList.join(' · ') }) : '';
}

// 캡처 시작 때 읽는 안내. 꺼진 기능마다 켜는 단축키를 붙인다. 모두 켜져 있으면 빈 문구다.
export function describeDisabledFeatureNotice({ store, t = defaultUiText }) {
  const itemList = FEATURE_KEY_LIST.filter((key) => !store.isOn(key))
    .map((key) => t('feature.offNoticeItem', { label: readFeatureLabel({ key, t }), shortcut: FEATURE_SHORTCUT_MAP[key].spoken }));
  return itemList.length ? t('feature.offNotice', { itemList: itemList.join(', ') }) : '';
}

export function listDisabledNarrationClass({ store }) {
  return FEATURE_KEY_LIST
    .filter((key) => NARRATION_CLASS_BY_FEATURE_MAP[key] && !store.isOn(key))
    .map((key) => NARRATION_CLASS_BY_FEATURE_MAP[key]);
}
