const { app } = require('electron');
const { loadEnvFile } = require('./env');

loadEnvFile();

const fs = require('fs');
const { FRAMES_DIR, DEIXIS_NARRATED_DIR, DEIXIS_SKIPPED_DIR, SLIDES_DIR, SUMMARIES_DIR } = require('./paths');
const { registerIpc } = require('./ipc');
const { registerPipeline } = require('./caption-pipeline');
const { registerSummary } = require('./summary');
const { registerCommandShortcut } = require('./shortcut');
const { registerViewerDisplayMedia } = require('./meeting/session');
const window = require('./window');

app.whenReady().then(() => {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  fs.mkdirSync(DEIXIS_NARRATED_DIR, { recursive: true });
  fs.mkdirSync(DEIXIS_SKIPPED_DIR, { recursive: true });
  fs.mkdirSync(SLIDES_DIR, { recursive: true });
  fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
  registerIpc({ getViewerView: window.getViewerView });

  const pipelineHandle = registerPipeline({ getViewerView: window.getViewerView });
  registerSummary({ getViewerView: window.getViewerView, pipelineHandle });
  window.createWindow();

  registerViewerDisplayMedia({ getMeetView: window.getMeetView });
  registerCommandShortcut({
    getViewerView: window.getViewerView, getMeetView: window.getMeetView,
  });

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
