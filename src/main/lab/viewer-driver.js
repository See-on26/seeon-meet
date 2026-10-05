// production 화면(viewer)의 버튼을 실험 main 이 대신 누른다. 화면 요소 이름은 여기 한 곳에만 둔다.
const VIEWER_SELECTOR_MAP = {
  toggleButton: '#toggleBtn',
  pauseButton: '#pauseBtn',
  liveState: '#liveState',
  modeToggle: '#modeToggle',
  concurrentAxis: '#modeToggle .opt[data-axis="concurrent"]',
  modeSegment: '#modeSegment',
};

const LIVE_STATE_TEXT = 'LIVE';
const CONCURRENT_MODE = 'realtime_mix';

function buildClickScript({ selector }) {
  return `(() => { const element = document.querySelector(${JSON.stringify(selector)});`
    + ' if (!element || element.disabled) return false; element.click(); return true; })()';
}

function buildIsEnabledScript({ selector }) {
  return `(() => { const element = document.querySelector(${JSON.stringify(selector)}); return Boolean(element) && !element.disabled; })()`;
}

const IS_LIVE_SCRIPT = `(() => document.querySelector(${JSON.stringify(VIEWER_SELECTOR_MAP.liveState)})?.textContent === ${JSON.stringify(LIVE_STATE_TEXT)})()`;

// 지금 고른 모드. 동시 축이면 realtime_mix, 교차 축이면 켜진 세부 모드 버튼이다.
const READ_MODE_SCRIPT = `(() => {
  const toggle = document.querySelector(${JSON.stringify(VIEWER_SELECTOR_MAP.modeToggle)});
  if (!toggle) return null;
  if (toggle.dataset.axis === 'concurrent') return ${JSON.stringify(CONCURRENT_MODE)};
  return document.querySelector(${JSON.stringify(`${VIEWER_SELECTOR_MAP.modeSegment} button.on`)})?.dataset.mode || null;
})()`;

// 교차 모드 버튼은 숨겨져 있어도 click() 으로 누를 수 있다. 캡처 시작 전에만 부른다(시작 뒤 교차→동시는 막혀 있다).
function buildSelectModeScript({ mode }) {
  const selector = mode === CONCURRENT_MODE
    ? VIEWER_SELECTOR_MAP.concurrentAxis
    : `${VIEWER_SELECTOR_MAP.modeSegment} button[data-mode="${mode}"]`;
  return buildClickScript({ selector });
}

function createViewerDriver({ getWebContents }) {
  function run(script) {
    const webContents = getWebContents();
    if (!webContents || webContents.isDestroyed()) return Promise.reject(new Error('production 화면이 없다'));
    return webContents.executeJavaScript(script, true);
  }
  return {
    readMode: () => run(READ_MODE_SCRIPT),
    async selectMode({ mode }) {
      const isClicked = await run(buildSelectModeScript({ mode }));
      return isClicked ? run(READ_MODE_SCRIPT) : null;
    },
    isStartable: () => run(buildIsEnabledScript({ selector: VIEWER_SELECTOR_MAP.toggleButton })),
    isLive: () => run(IS_LIVE_SCRIPT),
    clickToggle: () => run(buildClickScript({ selector: VIEWER_SELECTOR_MAP.toggleButton })),
    clickPause: () => run(buildClickScript({ selector: VIEWER_SELECTOR_MAP.pauseButton })),
    reload() {
      const webContents = getWebContents();
      return new Promise((resolve) => {
        webContents.once('did-finish-load', resolve);
        webContents.reload();
      });
    },
  };
}

module.exports = {
  createViewerDriver, buildSelectModeScript, buildClickScript, VIEWER_SELECTOR_MAP, LIVE_STATE_TEXT, READ_MODE_SCRIPT,
};
