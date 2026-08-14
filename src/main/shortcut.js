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

function attachShortcutListener({ webContents, getViewerView }) {
  webContents.on('before-input-event', (event, input) => {
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

function registerCommandShortcut({ getViewerView, getMeetView = () => null }) {
  const viewerView = getViewerView();
  if (!viewerView) { console.warn('[shortcut] 뷰어가 없어 커맨드 단축키를 등록하지 못했다'); return; }
  attachShortcutListener({ webContents: viewerView.webContents, getViewerView });
  const meetView = getMeetView();
  if (meetView) attachShortcutListener({ webContents: meetView.webContents, getViewerView });
  console.log(`[shortcut] 커맨드 단축키 등록 (${meetView ? '뷰어+Meet' : '뷰어'}) — Ctrl+${Object.keys(USER_COMMAND_KEY_MAP).join('/')} · 회의 요약 토글 Ctrl+${SUMMARY_TOGGLE_KEY}`);
}

module.exports = {
  registerCommandShortcut, readCommandFromInput, isSummaryToggleInput,
  USER_COMMAND_KEY_MAP, SUMMARY_TOGGLE_KEY,
};
