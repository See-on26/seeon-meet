// 화면 공유가 시작될 때 Meet 화면이 검게 남는 경우가 있어, Meet 화면만 다시 불러와 복구한다.
// 회의 중이면 Meet 이 참여 대기 화면으로 돌아가므로 다시 참여해야 한다.
function reloadMeetView({ getMeetView, getViewerView, reason }) {
  const meetView = getMeetView();
  if (!meetView || meetView.webContents.isDestroyed()) return false;
  console.log(`[meet] Meet 화면 새로고침 (${reason})`);
  meetView.webContents.reload();
  const viewerView = getViewerView();
  if (viewerView && !viewerView.webContents.isDestroyed()) {
    viewerView.webContents.send('meet-reloaded', { reason });
  }
  return true;
}

function registerMeetReload({ ipcMain, getMeetView, getViewerView }) {
  ipcMain.handle('meet-reload', async () => ({
    isOk: reloadMeetView({ getMeetView, getViewerView, reason: 'button' }),
  }));
}

module.exports = { reloadMeetView, registerMeetReload };
