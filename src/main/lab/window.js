const { BaseWindow, WebContentsView, session } = require('electron');
const path = require('path');
const { computeLabLayout, readWindowSize } = require('./layout');

// 세션을 나눠 제품 앱의 localStorage(기능 토글 등)와 섞이지 않고, 세션마다 다른 화면 캡처 처리기를 둔다.
const VIEWER_PARTITION = 'persist:lab-viewer';
const PLAYER_PARTITION = 'persist:lab-player';
const PRELOAD_DIR = path.join(__dirname, '..', '..', 'preload');
const RENDERER_DIR = path.join(__dirname, '..', '..', 'renderer');

let win = null;
let controlView = null;
let playerView = null;
let viewerView = null;
let captureRequestListener = () => {};

const getWindow = () => win;
const getControlView = () => controlView;
const getPlayerView = () => playerView;
const getViewerView = () => viewerView;

function setCaptureRequestListener(listener) {
  captureRequestListener = listener;
}

function registerDisplayMediaHandlerList() {
  // viewer 는 Meet 대신 재생 화면을 캡처한다. production Meet 캡처와 같은 경로(화면+소리, 원래 소리는 꺼짐)다.
  session.fromPartition(VIEWER_PARTITION).setDisplayMediaRequestHandler((_request, callback) => {
    if (!playerView || playerView.webContents.isDestroyed()) return callback(null);
    captureRequestListener({ wallMs: Date.now() });
    return callback({ video: playerView.webContents.mainFrame, audio: playerView.webContents.mainFrame });
  });
  // 재생 화면은 viewer 가 내는 소리를 녹음한다. enableLocalEcho 라서 녹음하는 동안에도 사용자에게 들린다.
  session.fromPartition(PLAYER_PARTITION).setDisplayMediaRequestHandler((_request, callback) => {
    if (!viewerView || viewerView.webContents.isDestroyed()) return callback(null);
    return callback({ video: viewerView.webContents.mainFrame, audio: viewerView.webContents.mainFrame, enableLocalEcho: true });
  });
}

function getLayout() {
  if (!win) return null;
  const { width, height } = win.getContentBounds();
  return computeLabLayout({ width, height });
}

function layoutViews() {
  const layout = getLayout();
  if (!layout) return;
  controlView.setBounds(layout.control);
  playerView.setBounds(layout.player);
  viewerView.setBounds(layout.viewer);
}

function createLabWindow({ size = readWindowSize() } = {}) {
  win = new BaseWindow({ width: size.width, height: size.height, useContentSize: true, title: 'seeon 실험 모드' });
  registerDisplayMediaHandlerList();
  controlView = new WebContentsView({
    webPreferences: { preload: path.join(PRELOAD_DIR, 'lab-control.js'), contextIsolation: true },
  });
  playerView = new WebContentsView({
    webPreferences: {
      session: session.fromPartition(PLAYER_PARTITION),
      preload: path.join(PRELOAD_DIR, 'lab-player.js'),
      contextIsolation: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // production viewer preload 를 그대로 불러 감싸려면 require 가 돼야 해서 sandbox 를 끈다.
  viewerView = new WebContentsView({
    webPreferences: {
      session: session.fromPartition(VIEWER_PARTITION),
      preload: path.join(PRELOAD_DIR, 'lab-viewer.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  for (const view of [controlView, playerView, viewerView]) win.contentView.addChildView(view);
  layoutViews();
  win.on('resize', layoutViews);

  controlView.webContents.loadFile(path.join(RENDERER_DIR, 'lab', 'control.html'));
  playerView.webContents.loadFile(path.join(RENDERER_DIR, 'lab', 'player.html'));
  viewerView.webContents.loadFile(path.join(RENDERER_DIR, 'app', 'index.html'));

  win.on('closed', () => {
    win = null;
    controlView = null;
    playerView = null;
    viewerView = null;
  });
  return win;
}

module.exports = {
  createLabWindow, getWindow, getControlView, getPlayerView, getViewerView, getLayout, setCaptureRequestListener,
  VIEWER_PARTITION, PLAYER_PARTITION,
};
