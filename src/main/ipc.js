const { ipcMain, systemPreferences, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { OUT_DIR, FRAMES_DIR, DEIXIS_NARRATED_DIR, DEIXIS_SKIPPED_DIR, resolveSlideDir } = require('./paths');
const { createRoiRelay } = require('./meeting/roi-relay');

// preload/meeting과 renderer/core는 번들러가 없어 각자 정의한다 — 값 변경 시 함께 갱신할 것
const SCREEN_SHARE_ROI_TYPE = 'screen_share';

const MAX_FRAME_FILES = 200;
let isPruningFrameDir = false;

async function pruneFrameDir() {
  if (isPruningFrameDir) return;
  isPruningFrameDir = true;
  try {
    const nameList = (await fs.promises.readdir(FRAMES_DIR)).filter((name) => name.endsWith('.jpg'));
    if (nameList.length <= MAX_FRAME_FILES) return;

    const sortedList = nameList
      .map((name) => ({ name, ts: Number((name.match(/(\d+)\.jpg$/) || [])[1]) || 0 }))
      .sort((frameA, frameB) => frameA.ts - frameB.ts);
    const removeList = sortedList.slice(0, sortedList.length - MAX_FRAME_FILES);
    await Promise.all(removeList.map(({ name }) =>
      fs.promises.unlink(path.join(FRAMES_DIR, name)).catch(() => {})));
  } finally {
    isPruningFrameDir = false;
  }
}

function isRoiPayloadShape(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (!Array.isArray(payload.roiList)) return false;
  const viewport = payload.viewport;
  return Boolean(viewport) && Number(viewport.vw) > 0 && Number(viewport.vh) > 0;
}

function registerIpc({ getViewerView }) {
  const roiRelay = createRoiRelay({
    send: (payload) => {
      const viewerView = getViewerView();
      if (!viewerView || viewerView.webContents.isDestroyed()) return;
      viewerView.webContents.send('roi-update', payload);
    },
  });
  let isFirstRoiUpdateLogged = false;
  let lastScreenShareSignature = null;
  ipcMain.on('roi-update', (_event, payload) => {
    if (!isRoiPayloadShape(payload)) return;

    if (!isFirstRoiUpdateLogged) {
      isFirstRoiUpdateLogged = true;
      const { vw, vh, dpr } = payload.viewport;
      console.log(`[roi] Meet 스캔 첫 수신 — 뷰포트 ${vw}×${vh} dpr=${dpr} roi=${payload.roiList.length}개`);
    }
    // 공유화면을 키워드로 잡았는지 크기 폴백으로 승격했는지 — 오검출 진단의 핵심 갈림길이다
    const screenRoi = payload.roiList.find((roi) => roi.type === SCREEN_SHARE_ROI_TYPE) || null;
    const signature = screenRoi
      ? `${screenRoi.lowConfidence ? '크기폴백' : '키워드'}:${screenRoi.participantId}` : '없음';
    if (signature !== lastScreenShareSignature) {
      lastScreenShareSignature = signature;
      console.log(`[roi] 공유화면 판정 → ${signature} · 타일 ${payload.roiList.length}개`
        + (screenRoi ? ` 이름="${screenRoi.name}" 라벨="${String(screenRoi.label || '').slice(0, 60)}"` : ''));
    }
    roiRelay.push({ payload });
  });

  ipcMain.handle('save-frame', async (_event, { name, buffer }) => {
    const file = path.join(FRAMES_DIR, path.basename(name));
    await fs.promises.writeFile(file, Buffer.from(buffer));
    pruneFrameDir();
    return file;
  });

  ipcMain.handle('save-deixis-frame', async (_event, { name, buffer, isGrounded }) => {
    const dir = isGrounded ? DEIXIS_NARRATED_DIR : DEIXIS_SKIPPED_DIR;
    const file = path.join(dir, path.basename(name));
    await fs.promises.writeFile(file, Buffer.from(buffer));
    return file;
  });

  ipcMain.handle('save-slide-frame', async (_event, { slideLabel, kind, buffer, sessionId = null }) => {
    const major = String(slideLabel).split('-')[0];
    const dir = resolveSlideDir({ sessionId, major });
    await fs.promises.mkdir(dir, { recursive: true });
    const isBase = kind === 'base';
    // 필기본은 슬라이드당 한 장만 남기고 덮어쓴다. 요약은 마지막 한 장만 읽으므로(slide-asset-resolver)
    // 중간 스냅샷을 모두 남기면 회의 1시간에 수천 장이 쌓이기만 하고 아무도 읽지 않는다.
    const file = path.join(dir, isBase ? 'base.jpg' : 'annotation.jpg');
    if (isBase && fs.existsSync(file)) return file;
    await fs.promises.writeFile(file, Buffer.from(buffer));
    return file;
  });

  ipcMain.handle('save-audio', async (_event, { name, buffer }) => {
    const file = path.join(OUT_DIR, path.basename(name));
    await fs.promises.writeFile(file, Buffer.from(buffer));
    return file;
  });

  ipcMain.handle('save-video', async (_event, { name, buffer }) => {
    const file = path.join(OUT_DIR, path.basename(name));
    await fs.promises.writeFile(file, Buffer.from(buffer));
    return file;
  });

  ipcMain.handle('save-text', async (_event, { name, text }) => {
    const file = path.join(OUT_DIR, path.basename(name));
    await fs.promises.writeFile(file, String(text), 'utf8');
    return file;
  });

  ipcMain.on('show-in-folder', (_event, filePath) => {
    const resolved = path.resolve(String(filePath));
    if (resolved.startsWith(OUT_DIR + path.sep)) shell.showItemInFolder(resolved);
  });

  ipcMain.handle('check-os-permissions', async () => {
    if (process.platform !== 'darwin') return { mic: 'granted', cam: 'granted' };
    const ask = async (type) => {
      if (systemPreferences.getMediaAccessStatus(type) === 'granted') return 'granted';
      return (await systemPreferences.askForMediaAccess(type)) ? 'granted' : 'denied';
    };
    return { mic: await ask('microphone'), cam: await ask('camera') };
  });

  ipcMain.on('open-privacy-settings', (_event, pane) => {
    const allowedPaneList = ['Microphone', 'Camera', 'ScreenCapture'];
    if (process.platform === 'darwin' && allowedPaneList.includes(pane)) {
      shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`);
    }
  });
}

module.exports = { registerIpc, isRoiPayloadShape };
