// Electron 기본 메뉴의 새로고침(Cmd/Ctrl+R)은 BaseWindow 에서 어느 화면을 다시 불러올지 보장되지 않는다.
// 같은 단축키를 Meet 화면 새로고침에 직접 연결하고, 복사·붙여넣기 같은 표준 메뉴는 그대로 둔다.
const MEET_RELOAD_ACCELERATOR = 'CmdOrCtrl+R';
// 패널 단축키는 다른 SEEON 단축키처럼 두 화면의 키 입력에서 받는다(맥도 Control).
// 메뉴에는 표시만 하고 등록하지 않아야 한 번 누를 때 두 번 접혔다 펴지지 않는다.
const VIEWER_PANEL_TOGGLE_ACCELERATOR = 'Ctrl+B';

function buildAppMenuTemplate({ onReloadMeet, onToggleViewerPanel, platform = process.platform }) {
  const isMac = platform === 'darwin';
  return [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: '보기',
      submenu: [
        { label: 'Meet 화면 새로고침', accelerator: MEET_RELOAD_ACCELERATOR, click: () => onReloadMeet() },
        {
          label: 'SEEON 패널 접기·펼치기', accelerator: VIEWER_PANEL_TOGGLE_ACCELERATOR, registerAccelerator: false,
          click: () => onToggleViewerPanel(),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    // Windows 기본 창 메뉴는 최소화 Ctrl+M·닫기 Ctrl+W 를 걸어 마이크·화자 안내 단축키와 겹친다.
    // 최소화·닫기는 제목 표시줄 단추와 Alt+F4 로 한다. 맥은 Cmd 조합이라 겹치지 않아 그대로 둔다.
    ...(isMac ? [{ role: 'windowMenu' }] : []),
  ];
}

module.exports = { buildAppMenuTemplate, MEET_RELOAD_ACCELERATOR, VIEWER_PANEL_TOGGLE_ACCELERATOR };
