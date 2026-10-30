const { BaseWindow, BrowserWindow, WebContentsView, desktopCapturer, ipcMain, shell } = require('electron');
const path = require('path');
const { createMeetSession } = require('./meeting/session');
const { createSharePicker } = require('./meeting/share-picker');
const { MEET_HOME_URL, handleMeetWindowOpen } = require('./meeting/meet-navigation');
const { getUaForUrl } = require('./meeting/ua');
const { computeViewBoundsPair, createMeetResizeNotifier } = require('./viewer-panel-layout');

const SMOKE_URL = 'about:blank';

let win = null;
let viewerView = null;
let meetView = null;
let isViewerCollapsed = false;

const getWindow = () => win;
const getViewerView = () => viewerView;
const getMeetView = () => meetView;

// Meet 발표(화면 공유)에서 공유할 화면·창을 고르는 SEEON 선택 창. SEEON 창 자신은 목록에서 뺀다.
const sharePicker = createSharePicker({
  BrowserWindow, ipcMain, desktopCapturer, getParentWindow: getWindow,
  getOwnSourceIdList: () => (win ? [win.getMediaSourceId()] : []),
});

// 캡처 영상은 Meet 화면 크기를 바꾸고 수십 ms 안에 새 크기로 오지만, Meet 좌표는 수백 ms 뒤에 온다.
// 뷰어가 그 사이 옛 좌표로 새 화면을 자르지 않도록 크기를 바꾸기 전에 새 크기를 먼저 알린다.
const meetResizeNotifier = createMeetResizeNotifier({
  notify: ({ width, height }) => {
    if (!viewerView || viewerView.webContents.isDestroyed()) return;
    viewerView.webContents.send('meet-view-resized', { width, height });
  },
});

function layoutView() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  const { meetBounds, viewerBounds } = computeViewBoundsPair({
    contentWidth: width, contentHeight: height, isCollapsed: isViewerCollapsed,
  });
  meetResizeNotifier.observe(meetBounds);
  meetView.setBounds(meetBounds);
  viewerView.setBounds(viewerBounds);
}

// 창 크기는 그대로 두고 패널이 비운 폭만큼 Meet 화면이 늘고 준다(보통 창·최대화·전체 화면 모두).
// 창이 움직이지 않고 최대화·화면 분할 배치도 풀리지 않는다.
function setViewerCollapsed({ isCollapsed }) {
  if (!win || isCollapsed === isViewerCollapsed) return isViewerCollapsed;
  isViewerCollapsed = isCollapsed;
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
  const meetSession = createMeetSession({ getViewerView, pickShareSource: sharePicker.pick });
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

  win.on('closed', () => {
    win = null; viewerView = null; meetView = null; isViewerCollapsed = false;
    meetResizeNotifier.reset();
  });
}

module.exports = {
  createWindow, layoutView, getWindow, getViewerView, getMeetView, toggleViewerCollapsed, registerViewerPanel,
};
