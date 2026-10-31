const { app, ipcMain, Menu } = require('electron');
const { loadEnvFile } = require('./env');

loadEnvFile({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });

const fs = require('fs');
const { FRAMES_DIR, DEIXIS_NARRATED_DIR, DEIXIS_SKIPPED_DIR, SLIDES_DIR, SUMMARIES_DIR } = require('./paths');
const { registerIpc } = require('./ipc');
const { registerPipeline } = require('./caption-pipeline');
const { registerSummary } = require('./summary');
const { createDocumentsMeetingArchive, registerMeetingArchive } = require('./archive');
const { registerCommandShortcut } = require('./shortcut');
const { registerViewerDisplayMedia } = require('./meeting/session');
const window = require('./window');
const { reloadMeetView, registerMeetReload } = require('./meeting/meet-reload');
const { registerMeetMicControl } = require('./meeting/meet-mic-control');
const { buildAppMenuTemplate, MEET_RELOAD_ACCELERATOR } = require('./app-menu');
const { registerGpuTunnel } = require('./gpu-tunnel');

app.whenReady().then(() => {
  // GPU 서비스(127.0.0.1:880x)를 부르기 전에 터널부터 연다.
  registerGpuTunnel({ app, ipcMain, getViewerView: window.getViewerView });

  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  fs.mkdirSync(DEIXIS_NARRATED_DIR, { recursive: true });
  fs.mkdirSync(DEIXIS_SKIPPED_DIR, { recursive: true });
  fs.mkdirSync(SLIDES_DIR, { recursive: true });
  fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
  registerIpc({ getViewerView: window.getViewerView });

  const meetingArchive = createDocumentsMeetingArchive();
  // 요약을 만드는 중에 앱이 꺼졌던 회의는 "만드는 중"으로 남지 않게 실패로 돌린다.
  meetingArchive.failStalePendingSummary()
    .then((changedCount) => {
      if (changedCount) console.log(`[archive] 끝나지 않은 요약 ${changedCount}건을 실패로 표시`);
    })
    .catch((error) => console.warn(`[archive] 끝나지 않은 요약 정리 실패(무시): ${error.message}`));
  registerMeetingArchive({ meetingArchive });
  const pipelineHandle = registerPipeline({ getViewerView: window.getViewerView, meetingArchive });
  registerSummary({ getViewerView: window.getViewerView, pipelineHandle, meetingArchive });
  window.createWindow();

  registerViewerDisplayMedia({ getMeetView: window.getMeetView });
  registerCommandShortcut({
    getViewerView: window.getViewerView, getMeetView: window.getMeetView,
    onViewerPanelToggle: window.toggleViewerCollapsed,
  });
  window.registerViewerPanel({ ipcMain });
  registerMeetReload({ ipcMain, getMeetView: window.getMeetView, getViewerView: window.getViewerView });
  registerMeetMicControl({ ipcMain, getMeetView: window.getMeetView });
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate({
    onReloadMeet: () => reloadMeetView({
      getMeetView: window.getMeetView, getViewerView: window.getViewerView, reason: 'shortcut',
    }),
    onToggleViewerPanel: window.toggleViewerCollapsed,
  })));
  console.log(`[meet] Meet 화면 새로고침 단축키 등록 — ${MEET_RELOAD_ACCELERATOR}`);

  if (process.env.SEEON_SMOKE) {
    window.getViewerView().webContents.once('did-finish-load', () => console.log('[smoke] viewer loaded'));
    setTimeout(() => {
      const viewerView = window.getViewerView();
      const meetView = window.getMeetView();
      const ok = Boolean(window.getWindow())
        && Boolean(viewerView) && !viewerView.webContents.isDestroyed()
        && Boolean(meetView) && !meetView.webContents.isDestroyed();
      console.log(ok ? '[smoke] ok' : '[smoke] FAIL');
      app.exit(ok ? 0 : 1);
    }, 8000);
  }
});

app.on('window-all-closed', () => app.quit());
