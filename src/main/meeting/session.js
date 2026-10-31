const { session, systemPreferences } = require('electron');
const { CHROME_UA, getUaForUrl } = require('./ua');

function createMeetSession({ getViewerView, pickShareSource }) {
  const meetSession = session.fromPartition('persist:meet');
  meetSession.setUserAgent(CHROME_UA);

  meetSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = getUaForUrl(details.url);
    callback({ requestHeaders: details.requestHeaders });
  });

  meetSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowedPermissionList = ['media', 'mediaKeySystem', 'notifications', 'clipboard-read', 'display-capture'];
    callback(allowedPermissionList.includes(permission));
  });
  meetSession.setPermissionCheckHandler((_wc, permission) => {
    return ['media', 'mediaKeySystem', 'notifications'].includes(permission);
  });

  meetSession.setDisplayMediaRequestHandler((_request, callback) => {
    if (process.platform === 'darwin'
      && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
      const viewerView = getViewerView();
      if (viewerView && !viewerView.webContents.isDestroyed()) {
        viewerView.webContents.send('os-screen-permission-denied');
      }
      return callback(null);
    }
    // macOS 15 이상은 시스템 선택 창이 먼저 떠 여기로 오지 않는다. Windows 는 SEEON 선택 창에서 화면·창을 고른다.
    pickShareSource()
      .then((source) => callback(source ? { video: source } : null))
      .catch(() => callback(null));
  }, { useSystemPicker: true });

  return meetSession;
}

function registerViewerDisplayMedia({ getMeetView }) {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const meetView = getMeetView();
    if (!meetView || meetView.webContents.isDestroyed()) return callback(null);
    callback({ video: meetView.webContents.mainFrame, audio: meetView.webContents.mainFrame });
  });
}

module.exports = { createMeetSession, registerViewerDisplayMedia };
