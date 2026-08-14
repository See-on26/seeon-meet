// 개발자 모드 흐름 창 preload. main 이 모은 이번 회의의 흐름·신호등 갱신값을 받는다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('devFlow', {
  onUpdate: (callback) => { ipcRenderer.on('dev-flow-update', (_event, snapshot) => callback(snapshot)); },
});
