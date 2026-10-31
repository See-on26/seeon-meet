import { USER_COMMAND_MAP } from '../constants.js';
import { defaultUiText } from '../i18n/ui-text.js';

// 질문 프리셋은 Ctrl+1~9 에 하나씩 걸린다. 번호(slot)는 1부터이고 목록 순서와 같다.
export const MAX_QUESTION_PRESET_COUNT = 9;
export const QUESTION_PRESET_STORAGE_KEY = 'seeon.questionPresets';

// 기본 문구는 화면에 맞춘 전용 지시문(명령)으로 답한다. 고치거나 새로 넣은 문구는 자유 질문으로 답한다.
const DEFAULT_QUESTION_PRESET_LIST = [
  { text: '무슨 자료야?', command: USER_COMMAND_MAP.screenMaterial },
  { text: '지금 화면 요약', command: USER_COMMAND_MAP.pageSummary },
  { text: '그래프 축이 뭐야?', command: USER_COMMAND_MAP.graphAxis },
];

export const DEFAULT_QUESTION_PRESET_TEXT_LIST = DEFAULT_QUESTION_PRESET_LIST.map((preset) => preset.text);

const COMMAND_BY_TEXT_MAP = new Map(DEFAULT_QUESTION_PRESET_LIST.map((preset) => [preset.text, preset.command]));

const DEFAULT_PRESET_TEXT_KEY_MAP = {
  [USER_COMMAND_MAP.screenMaterial]: 'preset.default.screenMaterial',
  [USER_COMMAND_MAP.pageSummary]: 'preset.default.pageSummary',
  [USER_COMMAND_MAP.graphAxis]: 'preset.default.graphAxis',
};

// 저장 값은 사용자가 넣은 문구 그대로다. 기본 문구(전용 명령)만 화면에서 캡션 언어의 이름으로 보인다.
// 한국어 이름은 저장된 기본 문구와 같아 한국어 화면은 그대로다.
export function readQuestionPresetText({ preset, t = defaultUiText }) {
  const key = preset.command ? DEFAULT_PRESET_TEXT_KEY_MAP[preset.command] : null;
  return key ? t(key) : preset.text;
}

export function readQuestionPresetSlotFromKey(key) {
  return /^[1-9]$/.test(key || '') ? Number(key) : null;
}

function normalizeTextList(rawList) {
  return rawList
    .filter((text) => typeof text === 'string')
    .map((text) => text.trim())
    .filter(Boolean)
    .slice(0, MAX_QUESTION_PRESET_COUNT);
}

// 한 번도 고치지 않았거나 저장 값이 깨졌으면 기본값이다. 모두 지운 빈 목록은 사용자가 고른 것이라 그대로 둔다.
function readStoredTextList({ storage }) {
  try {
    const parsed = JSON.parse(storage?.getItem(QUESTION_PRESET_STORAGE_KEY) ?? 'null');
    return Array.isArray(parsed) ? normalizeTextList(parsed) : [...DEFAULT_QUESTION_PRESET_TEXT_LIST];
  } catch {
    return [...DEFAULT_QUESTION_PRESET_TEXT_LIST];
  }
}

export function createQuestionPresetStore({ storage }) {
  let textList = readStoredTextList({ storage });
  const listenerList = [];

  function toPreset(text, index) {
    return { slot: index + 1, text, command: COMMAND_BY_TEXT_MAP.get(text) || null };
  }

  function list() {
    return textList.map(toPreset);
  }

  function replace(nextList) {
    if (nextList.length === textList.length && nextList.every((text, index) => text === textList[index])) return;
    textList = nextList;
    try {
      storage?.setItem(QUESTION_PRESET_STORAGE_KEY, JSON.stringify(textList));
    } catch {
      // 저장에 실패해도 이번 실행에서는 바뀐 프리셋으로 동작한다.
    }
    const presetList = list();
    for (const listener of listenerList) listener({ presetList });
  }

  function get(slot) {
    const index = slot - 1;
    return Number.isInteger(index) && index >= 0 && index < textList.length ? toPreset(textList[index], index) : null;
  }

  // 칸을 비우면 그 프리셋을 지운다.
  function setText(slot, text) {
    if (!get(slot)) return;
    const trimmed = String(text ?? '').trim();
    if (!trimmed) { remove(slot); return; }
    replace(textList.map((current, index) => (index === slot - 1 ? trimmed : current)));
  }

  function add(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed || textList.length >= MAX_QUESTION_PRESET_COUNT) return false;
    replace([...textList, trimmed]);
    return true;
  }

  function remove(slot) {
    if (!get(slot)) return;
    replace(textList.filter((_, index) => index !== slot - 1));
  }

  return {
    list, get, setText, add, remove,
    resetToDefault: () => replace([...DEFAULT_QUESTION_PRESET_TEXT_LIST]),
    subscribe: (listener) => { listenerList.push(listener); },
  };
}
