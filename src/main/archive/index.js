const path = require('path');
const { app, ipcMain, shell } = require('electron');
const { createMeetingArchive } = require('./meeting-archive');

const ARCHIVE_DIR_NAME = 'SEEON 회의 기록';

function createDocumentsMeetingArchive() {
  return createMeetingArchive({ rootDir: path.join(app.getPath('documents'), ARCHIVE_DIR_NAME) });
}

// 앱 안 "지난 회의" 보기: 목록, 회의 하나 읽기, 문서 폴더에서 열기.
function registerMeetingArchive({ meetingArchive }) {
  ipcMain.handle('meeting-archive-list', async () => ({ isOk: true, meetingList: await meetingArchive.list() }));
  ipcMain.handle('meeting-archive-read', async (_event, { id } = {}) => {
    const result = await meetingArchive.read({ id });
    if (!result.isOk) return result;
    const { meetingDir, ...rest } = result;
    return rest;
  });
  ipcMain.handle('meeting-archive-open-folder', async (_event, { id = null } = {}) => {
    const target = id ? (await meetingArchive.read({ id })).meetingDir : meetingArchive.rootDir;
    if (!target) return { isOk: false, message: '회의 기록 폴더를 찾지 못했어요' };
    const errorMessage = await shell.openPath(target);
    return errorMessage ? { isOk: false, message: errorMessage } : { isOk: true };
  });
}

module.exports = { createDocumentsMeetingArchive, registerMeetingArchive, ARCHIVE_DIR_NAME };
