import {
  createSubtitleState, reduceSubtitleState, readKeyAction, shouldFollowBottom, SUBTITLE_ACTION_MAP,
} from './subtitle/subtitle-state.js';

const lineListElement = document.getElementById('lineList');
let state = createSubtitleState();

function renderLine(line) {
  const lineElement = document.createElement('div');
  lineElement.className = `line ${line.kind}`;
  lineElement.textContent = line.text;
  return lineElement;
}

function applyStyle() {
  document.documentElement.style.setProperty('--visible-line-count', String(state.visibleLineCount));
  document.body.dataset.theme = state.theme;
}

function isFollowingBottom() {
  return shouldFollowBottom({
    scrollTop: lineListElement.scrollTop, clientHeight: lineListElement.clientHeight,
    scrollHeight: lineListElement.scrollHeight, lineHeightPx: lineListElement.clientHeight / state.visibleLineCount,
  });
}

// 새 줄은 이어 붙이기만 한다(지난 자막이 많아도 다시 그리지 않는다). 맨 아래를 보고 있었을 때만 따라 내려간다.
function dispatch(action) {
  const isFollowing = isFollowingBottom();
  const previous = state;
  state = reduceSubtitleState(state, action);
  if (state === previous) return;
  if (action.type === SUBTITLE_ACTION_MAP.line) {
    lineListElement.append(renderLine(action.line));
    while (lineListElement.childElementCount > state.lineList.length) lineListElement.firstElementChild.remove();
  } else {
    applyStyle();
    lineListElement.replaceChildren(...state.lineList.map(renderLine));
  }
  if (isFollowing) lineListElement.scrollTop = lineListElement.scrollHeight;
}

window.labSubtitle.onLine((line) => dispatch({ type: SUBTITLE_ACTION_MAP.line, line }));
window.addEventListener('keydown', (event) => {
  const actionType = readKeyAction({
    code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey,
  });
  if (!actionType) return;
  event.preventDefault();
  dispatch({ type: actionType });
});
applyStyle();
