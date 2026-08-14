const { BaseWindow, WebContentsView } = require('electron');
const path = require('path');
const { createMeetSession } = require('./meeting/session');
const { getUaForUrl } = require('./meeting/ua');

const MEET_VIEW_WIDTH_RATIO = 0.52;
const MEET_HOME_URL = 'https://meet.google.com/';

const SMOKE_URL = 'about:blank';

let win = null;
let viewerView = null;
let meetView = null;

const getWindow = () => win;
const getViewerView = () => viewerView;
const getMeetView = () => meetView;

function layoutView() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  const meetWidth = Math.round(width * MEET_VIEW_WIDTH_RATIO);
  meetView.setBounds({ x: 0, y: 0, width: meetWidth, height });
  viewerView.setBounds({ x: meetWidth, y: 0, width: width - meetWidth, height });
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

  view.webContents.setWindowOpenHandler(({ url }) => {
    view.webContents.loadURL(url);
    return { action: 'deny' };
  });

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

  win.on('closed', () => { win = null; viewerView = null; meetView = null; });
}

module.exports = { createWindow, layoutView, getWindow, getViewerView, getMeetView };
