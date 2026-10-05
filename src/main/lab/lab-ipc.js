const path = require('path');
const { BrowserWindow, dialog, shell } = require('electron');
const { OUT_DIR } = require('../paths');
const { createRunRecorder } = require('./run-recorder');
const { createRunController } = require('./run-controller');
const { createViewerDriver } = require('./viewer-driver');
const { createPlayerDriver } = require('./player-driver');
const { createOutputWriter } = require('./output-writer');
const { buildFeatureTogglePreset } = require('./feature-toggle-preset');
const { readGitInfo } = require('./git-info');
const { finalizeRun } = require('./export/finalize-run');
const { pickModelConfig } = require('./export/run-info');
const { createDemoWindowManager } = require('./demo-window');
const { buildDemoCard } = require('./demo-card');

const LAB_OUT_DIR = path.join(OUT_DIR, 'lab');
const VIDEO_EXTENSION_LIST = ['mp4', 'mov', 'webm', 'mkv', 'm4v'];

function registerLabIpc({ ipcMain, labWindow, pipelineConfig, onRunFinished = () => {} }) {
  // 처음 뜰 때부터 평가 설정으로 둔다. 실행마다 조작 바 값으로 바꾸고 viewer 를 새로 불러 적용한다.
  const presetState = { isEvalPreset: true };
  const demoWindowManager = createDemoWindowManager({ BrowserWindow });
  const sendStatus = (status) => {
    const controlView = labWindow.getControlView();
    if (controlView && !controlView.webContents.isDestroyed()) controlView.webContents.send('lab-status', status);
  };
  const controller = createRunController({
    viewerDriver: createViewerDriver({ getWebContents: () => labWindow.getViewerView()?.webContents }),
    playerDriver: createPlayerDriver({ getWebContents: () => labWindow.getPlayerView()?.webContents }),
    recorder: createRunRecorder(),
    finalize: finalizeRun,
    readGit: readGitInfo,
    createOutputWriter,
    setViewerPreset: ({ isEvalPreset }) => { presetState.isEvalPreset = isEvalPreset; },
    labRootDir: LAB_OUT_DIR,
    modelConfig: pickModelConfig(pipelineConfig),
    getLayout: labWindow.getLayout,
    notify: sendStatus,
    // 해설이 들리기 시작할 때 시연 창에 카드를 보낸다(시연 창이 닫혀 있으면 버린다).
    onPlayback: ({ playback, caption }) => demoWindowManager.sendCard(buildDemoCard({ playback, caption })),
    onRunFinished,
  });
  labWindow.setCaptureRequestListener(controller.handleCaptureRequested);

  ipcMain.on('lab-viewer-preset', (event) => { event.returnValue = buildFeatureTogglePreset(presetState); });
  ipcMain.on('lab-viewer-event', (_event, payload) => controller.handleViewerEvent(payload));
  ipcMain.on('lab-narration-playback', (_event, report) => controller.handleNarrationPlayback(report));
  // production 파이프라인도 이 채널을 받는다. 실험 main 은 버려진 해설의 사유만 함께 적는다.
  ipcMain.on('pipeline-narration-dropped', (_event, drop) => controller.handleRendererDrop(drop));
  ipcMain.on('lab-player-time', (_event, report) => controller.handlePlayerTime(report));
  ipcMain.handle('lab-output-chunk', (_event, { buffer }) => controller.handleOutputChunk({ buffer }));
  ipcMain.on('lab-output-state', (_event, state) => controller.handleOutputState(state));
  ipcMain.on('lab-player-error', (_event, { message }) => console.warn(`[lab] 재생 화면 오류: ${message}`));

  ipcMain.handle('lab-pick-video', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'], filters: [{ name: '녹화 영상', extensions: VIDEO_EXTENSION_LIST }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('lab-start', (_event, option) => controller.start(option || {}));
  ipcMain.handle('lab-pause', () => controller.pause());
  ipcMain.handle('lab-resume', () => controller.resume());
  ipcMain.handle('lab-stop', () => controller.stop());
  ipcMain.handle('lab-roi-edit', (_event, { isEditing }) => controller.setRoiEditing({ isEditing: Boolean(isEditing) }));
  ipcMain.handle('lab-status', () => controller.getStatus());
  ipcMain.handle('lab-open-demo', () => {
    demoWindowManager.open();
    return { isOk: true };
  });
  ipcMain.handle('lab-open-result', async () => {
    const { lastRunDir, runDir } = controller.getStatus();
    const targetDir = lastRunDir || runDir;
    if (!targetDir) return { isOk: false, message: '아직 결과 폴더가 없다' };
    await shell.openPath(targetDir);
    return { isOk: true, runDir: targetDir };
  });
  return controller;
}

module.exports = { registerLabIpc, LAB_OUT_DIR };
