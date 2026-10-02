// Electron 기본 메뉴의 새로고침(Cmd/Ctrl+R)은 BaseWindow 에서 어느 화면을 다시 불러올지 보장되지 않는다.
// 같은 단축키를 Meet 화면 새로고침에 직접 연결하고, 복사·붙여넣기 같은 표준 메뉴는 그대로 둔다.
const MEET_RELOAD_ACCELERATOR = 'CmdOrCtrl+R';

function buildAppMenuTemplate({ onReloadMeet, platform = process.platform }) {
  const isMac = platform === 'darwin';
  return [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: '보기',
      submenu: [
        { label: 'Meet 화면 새로고침', accelerator: MEET_RELOAD_ACCELERATOR, click: () => onReloadMeet() },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
}

module.exports = { buildAppMenuTemplate, MEET_RELOAD_ACCELERATOR };
