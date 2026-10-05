// 재생 화면 페이지(player.js)가 window.labPlayer 로 연 함수를 실험 main 이 부른다.
// 화면 캡처(getDisplayMedia)는 사용자 조작이 있어야 하므로 userGesture 로 부른다.
const PLAYER_METHOD_LIST = ['load', 'play', 'pause', 'setRoiEditing', 'startOutputRecording', 'stopOutputRecording', 'getState'];

function buildPlayerCallScript({ method, arg = undefined }) {
  if (!PLAYER_METHOD_LIST.includes(method)) throw new Error(`재생 화면에 없는 함수: ${method}`);
  return `window.labPlayer.${method}(${arg === undefined ? '' : JSON.stringify(arg)})`;
}

function createPlayerDriver({ getWebContents }) {
  function call(method, arg) {
    const webContents = getWebContents();
    if (!webContents || webContents.isDestroyed()) return Promise.reject(new Error('재생 화면이 없다'));
    return webContents.executeJavaScript(buildPlayerCallScript({ method, arg }), true);
  }
  return {
    load: ({ fileUrl }) => call('load', { fileUrl }),
    play: () => call('play'),
    pause: () => call('pause'),
    setRoiEditing: ({ isEditing }) => call('setRoiEditing', { isEditing }),
    startOutputRecording: () => call('startOutputRecording'),
    stopOutputRecording: () => call('stopOutputRecording'),
    getState: () => call('getState'),
  };
}

module.exports = { createPlayerDriver, buildPlayerCallScript, PLAYER_METHOD_LIST };
