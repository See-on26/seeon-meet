const { BaseWindow, WebContentsView, screen, shell } = require('electron');
const path = require('path');
const { createMeetSession } = require('./meeting/session');
const { MEET_HOME_URL, handleMeetWindowOpen } = require('./meeting/meet-navigation');
const { getUaForUrl } = require('./meeting/ua');
const { computeViewBoundsPair, computeToggledWindowBounds } = require('./viewer-panel-layout');

const SMOKE_URL = 'about:blank';

let win = null;
let viewerView = null;
let meetView = null;
let isViewerCollapsed = false;

const getWindow = () => win;
const getViewerView = () => viewerView;
const getMeetView = () => meetView;

function layoutView() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  const { meetBounds, viewerBounds } = computeViewBoundsPair({
    contentWidth: width, contentHeight: height, isCollapsed: isViewerCollapsed,
  });
  meetView.setBounds(meetBounds);
  viewerView.setBounds(viewerBounds);
}

// 전체 화면이면 창 폭을 바꿀 수 없어, 창 크기를 바꿀 때처럼 Meet 화면 폭이 대신 바뀐다.
// 최대화된 창(맥은 화면을 꽉 채운 창도 최대화로 본다)은 최대화를 풀고 줄인다. 윈도우는 최대화를 풀면
// 이전 크기로 돌아가므로 풀기 전 크기를 기준으로 계산한다.
// 창 크기와 화면 배치는 한 번에 바꿔야 중간 크기의 Meet 화면이 캡처되지 않는다.
function setViewerCollapsed({ isCollapsed }) {
  if (!win || isCollapsed === isViewerCollapsed) return isViewerCollapsed;
  isViewerCollapsed = isCollapsed;
  if (!win.isFullScreen()) {
    const windowBounds = win.getBounds();
    const { workArea } = screen.getDisplayMatching(windowBounds);
    if (win.isMaximized() && process.platform !== 'darwin') win.unmaximize();
    win.setBounds(computeToggledWindowBounds({ windowBounds, workArea, isCollapsed }));
  }
  layoutView();
  viewerView.webContents.send('viewer-panel-changed', { isCollapsed });
  return isViewerCollapsed;
}

const toggleViewerCollapsed = () => setViewerCollapsed({ isCollapsed: !isViewerCollapsed });

function registerViewerPanel({ ipcMain }) {
  ipcMain.handle('viewer-panel-set', async (_event, { isCollapsed } = {}) => ({
    isCollapsed: setViewerCollapsed({ isCollapsed: Boolean(isCollapsed) }),
  }));
}

function createMeetView() {
  const meetSession = createMeetSession({ getViewerView });
  const view = new WebContentsView({
    webPreferences: {
      session: meetSession,
      preload: path.join(__dirname, '..', 'preload', 'meeting', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  view.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) view.webContents.setUserAgent(getUaForUrl(url));
  });

  view.webContents.setWindowOpenHandler(({ url }) => handleMeetWindowOpen({
    url,
    loadInView: (target) => view.webContents.loadURL(target),
    openExternal: (target) => shell.openExternal(target)
      .catch((error) => console.warn(`[meet] 기본 브라우저로 열지 못함: ${error.message}`)),
  }));

  view.webContents.loadURL(process.env.SEEON_SMOKE ? SMOKE_URL : MEET_HOME_URL);
  return view;
}

function createWindow() {
  win = new BaseWindow({ width: 1600, height: 900, title: 'seeon' });

  meetView = createMeetView();

  viewerView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'viewer.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  win.contentView.addChildView(meetView);
  win.contentView.addChildView(viewerView);
  layoutView();
  win.on('resize', layoutView);

  viewerView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'app', 'index.html'));

  win.on('closed', () => { win = null; viewerView = null; meetView = null; isViewerCollapsed = false; });
}

module.exports = {
  createWindow, layoutView, getWindow, getViewerView, getMeetView, toggleViewerCollapsed, registerViewerPanel,
};
