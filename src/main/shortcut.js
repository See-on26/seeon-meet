const { USER_COMMAND_MAP } = require('./caption-pipeline/contracts/narration-types');

const USER_COMMAND_KEY_MAP = {
  5: USER_COMMAND_MAP.screenMaterial,
  6: USER_COMMAND_MAP.pageSummary,
  7: USER_COMMAND_MAP.graphAxis,
};

const SUMMARY_TOGGLE_KEY = '0';

function readCommandFromInput({ input }) {
  if (!input || input.type !== 'keyDown') return null;
  if (!(input.control || input.meta)) return null;
  if (input.shift || input.alt) return null;
  return USER_COMMAND_KEY_MAP[input.key] || null;
}

function isSummaryToggleInput({ input }) {
  if (!input || input.type !== 'keyDown') return false;
  if (!(input.control || input.meta)) return false;
  if (input.shift || input.alt) return false;
  return input.key === SUMMARY_TOGGLE_KEY;
}

const MIC_TOGGLE_KEY = '8';

// 키를 누르고 있으면 keyDown 이 반복된다. 반복분까지 토글로 보면 녹음이 켜졌다 꺼졌다 한다.
function isMicToggleInput({ input }) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return false;
  if (!(input.control || input.meta)) return false;
  if (input.shift || input.alt) return false;
  return input.key === MIC_TOGGLE_KEY;
}

const VIEWER_PANEL_TOGGLE_KEY = '9';

function isViewerPanelToggleInput({ input }) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return false;
  if (!(input.control || input.meta)) return false;
  if (input.shift || input.alt) return false;
  return input.key === VIEWER_PANEL_TOGGLE_KEY;
}

// Shift 를 누르면 key 가 '!'·'@' 처럼 바뀌므로 자판 위치(code)로 숫자를 읽는다.
const FEATURE_TOGGLE_CODE_PATTERN = /^Digit([1-3])$/;

function readFeatureToggleDigit({ input }) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return null;
  if (!(input.control || input.meta)) return null;
  if (!input.shift || input.alt) return null;
  const matched = FEATURE_TOGGLE_CODE_PATTERN.exec(input.code || '');
  return matched ? matched[1] : null;
}

function attachShortcutListener({ webContents, getViewerView, onViewerPanelToggle }) {
  webContents.on('before-input-event', (event, input) => {
    if (isViewerPanelToggleInput({ input })) {
      event.preventDefault();
      console.log('[shortcut] 패널 접기·펼치기');
      onViewerPanelToggle();
      return;
    }
    const featureDigit = readFeatureToggleDigit({ input });
    if (featureDigit) {
      event.preventDefault();
      const viewerView = getViewerView();
      if (!viewerView || viewerView.webContents.isDestroyed()) return;
      console.log(`[shortcut] 기능 토글 Ctrl+Shift+${featureDigit}`);
      viewerView.webContents.send('feature-toggle', { digit: featureDigit });
      return;
    }
    if (isMicToggleInput({ input })) {
      event.preventDefault();
      const viewerView = getViewerView();
      if (!viewerView || viewerView.webContents.isDestroyed()) return;
      console.log('[shortcut] 마이크 질문 토글');
      viewerView.webContents.send('mic-toggle');
      return;
    }
    const isToggle = isSummaryToggleInput({ input });
    const command = isToggle ? null : readCommandFromInput({ input });
    if (!isToggle && !command) return;
    event.preventDefault();
    const viewerView = getViewerView();
    if (!viewerView || viewerView.webContents.isDestroyed()) return;

    if (isToggle) {
      console.log('[shortcut] 회의 요약 토글');
      viewerView.webContents.send('summary-toggle');
      return;
    }
    console.log(`[shortcut] 사용자 커맨드 ${command}`);
    viewerView.webContents.send('user-command', { command });
  });
}

function registerCommandShortcut({ getViewerView, getMeetView = () => null, onViewerPanelToggle = () => {} }) {
  const viewerView = getViewerView();
  if (!viewerView) { console.warn('[shortcut] 뷰어가 없어 커맨드 단축키를 등록하지 못했다'); return; }
  attachShortcutListener({ webContents: viewerView.webContents, getViewerView, onViewerPanelToggle });
  const meetView = getMeetView();
  if (meetView) attachShortcutListener({ webContents: meetView.webContents, getViewerView, onViewerPanelToggle });
  console.log(`[shortcut] 커맨드 단축키 등록 (${meetView ? '뷰어+Meet' : '뷰어'}) — Ctrl+${Object.keys(USER_COMMAND_KEY_MAP).join('/')} · 회의 요약 토글 Ctrl+${SUMMARY_TOGGLE_KEY} · 마이크 질문 Ctrl+${MIC_TOGGLE_KEY} · 패널 접기·펼치기 Ctrl+${VIEWER_PANEL_TOGGLE_KEY} · 기능 토글 Ctrl+Shift+1~3`);
}

module.exports = {
  registerCommandShortcut, readCommandFromInput, isSummaryToggleInput, isMicToggleInput,
  isViewerPanelToggleInput, readFeatureToggleDigit, USER_COMMAND_KEY_MAP, SUMMARY_TOGGLE_KEY, MIC_TOGGLE_KEY,
  VIEWER_PANEL_TOGGLE_KEY,
};
