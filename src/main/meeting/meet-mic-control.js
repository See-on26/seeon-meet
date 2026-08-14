const MEET_MIC_TOGGLE_KEY_CODE = 'D';

// Google Meet 의 마이크 토글 단축키(맥 Cmd+D, 그 외 Ctrl+D)를 Meet 화면에 보낸다.
function buildMeetMicToggleInputList({ platform }) {
  const modifiers = [platform === 'darwin' ? 'meta' : 'control'];
  return [
    { type: 'keyDown', keyCode: MEET_MIC_TOGGLE_KEY_CODE, modifiers },
    { type: 'keyUp', keyCode: MEET_MIC_TOGGLE_KEY_CODE, modifiers },
  ];
}

function registerMeetMicControl({ ipcMain, getMeetView, platform = process.platform }) {
  ipcMain.handle('meet-mic-toggle', async () => {
    const meetView = getMeetView();
    if (!meetView || meetView.webContents.isDestroyed()) return { isOk: false };
    for (const inputEvent of buildMeetMicToggleInputList({ platform })) {
      meetView.webContents.sendInputEvent(inputEvent);
    }
    console.log('[meet] Meet 마이크 토글 단축키 전송');
    return { isOk: true };
  });
}

module.exports = { buildMeetMicToggleInputList, registerMeetMicControl };
