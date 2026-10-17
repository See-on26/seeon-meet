// 자막 창 상태: 쌓인 줄, 한 화면에 보이는 줄 수(글자 크기), 바탕. 키 입력은 자판 위치(code)로 읽어 한글 입력 상태에서도 같게 동작한다.
export const SUBTITLE_LINE_COUNT_MAP = { min: 3, max: 14, initial: 7 };
// 위로 스크롤해 지난 자막을 다시 볼 수 있게 넉넉히 남긴다.
export const MAX_SUBTITLE_LINE_COUNT = 2000;
export const SUBTITLE_THEME_MAP = { dark: 'dark', light: 'light' };

export const SUBTITLE_ACTION_MAP = {
  line: 'line',
  fewerLines: 'fewer_lines',
  moreLines: 'more_lines',
  toggleTheme: 'toggle_theme',
  clear: 'clear',
};

const KEY_ACTION_MAP = {
  Equal: SUBTITLE_ACTION_MAP.fewerLines,
  NumpadAdd: SUBTITLE_ACTION_MAP.fewerLines,
  Minus: SUBTITLE_ACTION_MAP.moreLines,
  NumpadSubtract: SUBTITLE_ACTION_MAP.moreLines,
  KeyB: SUBTITLE_ACTION_MAP.toggleTheme,
  KeyC: SUBTITLE_ACTION_MAP.clear,
};

export function createSubtitleState() {
  return { lineList: [], visibleLineCount: SUBTITLE_LINE_COUNT_MAP.initial, theme: SUBTITLE_THEME_MAP.dark };
}

// ⌘·Ctrl·Option 을 함께 누른 키는 창의 기본 동작(⌘C 복사 등)으로 둔다.
export function readKeyAction({ code, metaKey = false, ctrlKey = false, altKey = false }) {
  if (metaKey || ctrlKey || altKey) return null;
  return KEY_ACTION_MAP[code] || null;
}

const clampLineCount = (count) => Math.min(SUBTITLE_LINE_COUNT_MAP.max, Math.max(SUBTITLE_LINE_COUNT_MAP.min, count));

export function reduceSubtitleState(state, action) {
  switch (action.type) {
    case SUBTITLE_ACTION_MAP.line:
      if (state.lineList.some((line) => line.id === action.line.id)) return state;
      return { ...state, lineList: [...state.lineList, action.line].slice(-MAX_SUBTITLE_LINE_COUNT) };
    case SUBTITLE_ACTION_MAP.fewerLines:
      return { ...state, visibleLineCount: clampLineCount(state.visibleLineCount - 1) };
    case SUBTITLE_ACTION_MAP.moreLines:
      return { ...state, visibleLineCount: clampLineCount(state.visibleLineCount + 1) };
    case SUBTITLE_ACTION_MAP.toggleTheme:
      return { ...state, theme: state.theme === SUBTITLE_THEME_MAP.dark ? SUBTITLE_THEME_MAP.light : SUBTITLE_THEME_MAP.dark };
    case SUBTITLE_ACTION_MAP.clear:
      return { ...state, lineList: [] };
    default:
      return state;
  }
}

// 맨 아래에서 한 줄 안쪽이면 맨 아래를 보고 있는 것으로 본다. 그때만 새 줄을 따라 내려간다.
export function shouldFollowBottom({ scrollTop, clientHeight, scrollHeight, lineHeightPx }) {
  return scrollHeight - (scrollTop + clientHeight) <= lineHeightPx;
}
