// 시연 창 상태: 쌓인 카드, 글자 크기, 근거 표시 여부. 키 입력은 자판 위치(code)로 읽어 한글 입력 상태에서도 같게 동작한다.
export const DEMO_FONT_SIZE_MAP = { min: 24, max: 96, step: 6, initial: 44 };
export const MAX_CARD_COUNT = 50;

export const DEMO_ACTION_MAP = {
  card: 'card',
  toggleRationale: 'toggle_rationale',
  fontUp: 'font_up',
  fontDown: 'font_down',
  clear: 'clear',
};

const KEY_ACTION_MAP = {
  KeyG: DEMO_ACTION_MAP.toggleRationale,
  Equal: DEMO_ACTION_MAP.fontUp,
  NumpadAdd: DEMO_ACTION_MAP.fontUp,
  Minus: DEMO_ACTION_MAP.fontDown,
  NumpadSubtract: DEMO_ACTION_MAP.fontDown,
  KeyC: DEMO_ACTION_MAP.clear,
};

export function createDemoState() {
  return { cardList: [], fontSizePx: DEMO_FONT_SIZE_MAP.initial, isRationaleVisible: false };
}

export function readKeyAction({ code }) {
  return KEY_ACTION_MAP[code] || null;
}

const clampFontSize = (fontSizePx) => Math.min(DEMO_FONT_SIZE_MAP.max, Math.max(DEMO_FONT_SIZE_MAP.min, fontSizePx));

export function reduceDemoState(state, action) {
  switch (action.type) {
    case DEMO_ACTION_MAP.card:
      if (state.cardList.some((card) => card.id === action.card.id)) return state;
      return { ...state, cardList: [...state.cardList, action.card].slice(-MAX_CARD_COUNT) };
    case DEMO_ACTION_MAP.toggleRationale:
      return { ...state, isRationaleVisible: !state.isRationaleVisible };
    case DEMO_ACTION_MAP.fontUp:
      return { ...state, fontSizePx: clampFontSize(state.fontSizePx + DEMO_FONT_SIZE_MAP.step) };
    case DEMO_ACTION_MAP.fontDown:
      return { ...state, fontSizePx: clampFontSize(state.fontSizePx - DEMO_FONT_SIZE_MAP.step) };
    case DEMO_ACTION_MAP.clear:
      return { ...state, cardList: [] };
    default:
      return state;
  }
}
