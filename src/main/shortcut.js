// 숫자 키(질문 프리셋 Ctrl+1~9, 회의 요약 Ctrl+0)는 맥에서도 Control·Cmd 둘 다 받는다.
const QUESTION_PRESET_KEY_PATTERN = /^[1-9]$/;
const SUMMARY_TOGGLE_KEY = '0';

// 키를 누르고 있으면 keyDown 이 반복된다. 반복분까지 받으면 같은 질문이 여러 번 나간다.
function readQuestionPresetSlot({ input }) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return null;
  if (!(input.control || input.meta)) return null;
  if (input.shift || input.alt) return null;
  return QUESTION_PRESET_KEY_PATTERN.test(input.key || '') ? Number(input.key) : null;
}

function isSummaryToggleInput({ input }) {
  if (!input || input.type !== 'keyDown') return false;
  if (!(input.control || input.meta)) return false;
  if (input.shift || input.alt) return false;
  return input.key === SUMMARY_TOGGLE_KEY;
}

// 글자 키는 Control 조합만 받는다. 맥의 Cmd+M(최소화)·Cmd+Q(종료)·Cmd+W(닫기)는 그대로 둔다.
// 한글 입력 상태에서는 key 가 'ㅡ'처럼 자모로 바뀌므로 자판 위치(code)로 읽는다.
function readControlLetterCode({ input }) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return null;
  if (!input.control || input.meta || input.shift || input.alt) return null;
  return input.code || null;
}

const MIC_TOGGLE_CODE = 'KeyM';
const VIEWER_PANEL_TOGGLE_CODE = 'KeyB';
// 값은 렌더러 feature-toggle-store 의 FEATURE_KEY_MAP 값과 같다. 회의 요약은 Ctrl+0 이다.
const FEATURE_TOGGLE_CODE_MAP = {
  KeyQ: 'page_transition',
  KeyW: 'speaker_identity',
};

function isMicToggleInput({ input }) {
  return readControlLetterCode({ input }) === MIC_TOGGLE_CODE;
}

function isViewerPanelToggleInput({ input }) {
  return readControlLetterCode({ input }) === VIEWER_PANEL_TOGGLE_CODE;
}

function readFeatureToggleKey({ input }) {
  return FEATURE_TOGGLE_CODE_MAP[readControlLetterCode({ input })] || null;
}

// Electron 은 preventDefault 한 키를 페이지와 메뉴 단축키 어느 쪽에도 넘기지 않는다.
function attachShortcutListener({ webContents, getViewerView, onViewerPanelToggle }) {
  function sendToViewer(channel, payload) {
    const viewerView = getViewerView();
    if (!viewerView || viewerView.webContents.isDestroyed()) return;
    viewerView.webContents.send(channel, payload);
  }

  webContents.on('before-input-event', (event, input) => {
    if (isViewerPanelToggleInput({ input })) {
      event.preventDefault();
      console.log('[shortcut] 패널 접기·펼치기');
      onViewerPanelToggle();
      return;
    }
    const feature = readFeatureToggleKey({ input });
    if (feature) {
      event.preventDefault();
      console.log(`[shortcut] 기능 토글 ${feature}`);
      sendToViewer('feature-toggle', { feature });
      return;
    }
    if (isMicToggleInput({ input })) {
      event.preventDefault();
      console.log('[shortcut] 마이크 질문 토글');
      sendToViewer('mic-toggle');
      return;
    }
    if (isSummaryToggleInput({ input })) {
      event.preventDefault();
      console.log('[shortcut] 회의 요약 토글');
      sendToViewer('summary-toggle');
      return;
    }
    const slot = readQuestionPresetSlot({ input });
    if (slot) {
      event.preventDefault();
      console.log(`[shortcut] 질문 프리셋 ${slot}`);
      sendToViewer('question-preset', { slot });
    }
  });
}

function registerCommandShortcut({ getViewerView, getMeetView = () => null, onViewerPanelToggle = () => {} }) {
  const viewerView = getViewerView();
  if (!viewerView) { console.warn('[shortcut] 뷰어가 없어 커맨드 단축키를 등록하지 못했다'); return; }
  attachShortcutListener({ webContents: viewerView.webContents, getViewerView, onViewerPanelToggle });
  const meetView = getMeetView();
  if (meetView) attachShortcutListener({ webContents: meetView.webContents, getViewerView, onViewerPanelToggle });
  console.log(`[shortcut] 커맨드 단축키 등록 (${meetView ? '뷰어+Meet' : '뷰어'}) — 질문 프리셋 Ctrl+1~9 · 회의 요약 토글 Ctrl+${SUMMARY_TOGGLE_KEY} · 마이크 질문 Ctrl+M · 페이지 전환 Ctrl+Q · 화자 안내 Ctrl+W · 패널 접기·펼치기 Ctrl+B`);
}

module.exports = {
  registerCommandShortcut, readQuestionPresetSlot, isSummaryToggleInput, isMicToggleInput,
  isViewerPanelToggleInput, readFeatureToggleKey, SUMMARY_TOGGLE_KEY, FEATURE_TOGGLE_CODE_MAP,
};
