const path = require('path');

// 심사위원 보기용 자막 창. 회의 소리와 AD 를 카드 없이 자막처럼 크게 띄운다. 줄은 실험 main 의 자막 줄 고르기가 보낸다.
const SUBTITLE_WINDOW_SIZE = { width: 1280, height: 800 };

function createSubtitleWindowManager({ BrowserWindow, rootDir = path.join(__dirname, '..', '..') }) {
  let subtitleWindow = null;
  const isOpen = () => Boolean(subtitleWindow) && !subtitleWindow.isDestroyed();
  return {
    isOpen,
    open() {
      if (isOpen()) {
        subtitleWindow.focus();
        return subtitleWindow;
      }
      subtitleWindow = new BrowserWindow({
        ...SUBTITLE_WINDOW_SIZE,
        title: 'seeon 자막 창',
        backgroundColor: '#000000',
        webPreferences: { preload: path.join(rootDir, 'preload', 'lab-subtitle.js'), contextIsolation: true },
      });
      subtitleWindow.loadFile(path.join(rootDir, 'renderer', 'lab', 'subtitle.html'));
      subtitleWindow.on('closed', () => { subtitleWindow = null; });
      return subtitleWindow;
    },
    sendLine(line) {
      if (isOpen()) subtitleWindow.webContents.send('lab-subtitle-line', line);
    },
  };
}

module.exports = { createSubtitleWindowManager };
