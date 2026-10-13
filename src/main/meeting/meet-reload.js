const { MEET_HOME_URL, isMeetingUrl } = require('./meet-navigation');

const MEET_RELOAD_TARGET_MAP = { meeting: 'meeting', home: 'home' };

// 화면 공유가 시작될 때 Meet 화면이 검게 남는 경우가 있어, Meet 화면만 다시 불러와 복구한다.
// 회의 중이면 Meet 이 참여 대기 화면으로 돌아가므로 다시 참여해야 한다.
// 회의 밖 페이지(다른 사이트 등)에 있으면 주소 창이 없어 돌아올 길이 없으므로 Meet 첫 화면을 불러온다.
function reloadMeetView({ getMeetView, getViewerView, reason }) {
  const meetView = getMeetView();
  if (!meetView || meetView.webContents.isDestroyed()) return false;
  const target = isMeetingUrl(meetView.webContents.getURL()) ? MEET_RELOAD_TARGET_MAP.meeting : MEET_RELOAD_TARGET_MAP.home;
  console.log(`[meet] Meet 화면 새로고침 (${reason}, ${target})`);
  if (target === MEET_RELOAD_TARGET_MAP.meeting) meetView.webContents.reload();
  else meetView.webContents.loadURL(MEET_HOME_URL);
  const viewerView = getViewerView();
  if (viewerView && !viewerView.webContents.isDestroyed()) {
    viewerView.webContents.send('meet-reloaded', { reason, target });
  }
  return true;
}

function registerMeetReload({ ipcMain, getMeetView, getViewerView }) {
  ipcMain.handle('meet-reload', async () => ({
    isOk: reloadMeetView({ getMeetView, getViewerView, reason: 'button' }),
  }));
}

module.exports = { reloadMeetView, registerMeetReload, MEET_RELOAD_TARGET_MAP };
