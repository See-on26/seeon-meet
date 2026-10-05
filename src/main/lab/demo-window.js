const path = require('path');

// 녹화 시연용 큰 글씨 AD 창. 실험 창이 받은 재생 시작 알림만 받으므로 나중에 Meet 앱에도 붙일 수 있다.
const DEMO_WINDOW_SIZE = { width: 1280, height: 800 };

function createDemoWindowManager({ BrowserWindow, rootDir = path.join(__dirname, '..', '..') }) {
  let demoWindow = null;
  const isOpen = () => Boolean(demoWindow) && !demoWindow.isDestroyed();
  return {
    isOpen,
    open() {
      if (isOpen()) {
        demoWindow.focus();
        return demoWindow;
      }
      demoWindow = new BrowserWindow({
        ...DEMO_WINDOW_SIZE,
        title: 'seeon 시연 창',
        backgroundColor: '#000000',
        webPreferences: { preload: path.join(rootDir, 'preload', 'lab-demo.js'), contextIsolation: true },
      });
      demoWindow.loadFile(path.join(rootDir, 'renderer', 'lab', 'demo.html'));
      demoWindow.on('closed', () => { demoWindow = null; });
      return demoWindow;
    },
    sendCard(card) {
      if (isOpen()) demoWindow.webContents.send('lab-demo-card', card);
    },
  };
}

module.exports = { createDemoWindowManager };
