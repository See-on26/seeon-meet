// 파이프라인 흐름 창 preload. lab main 이 모은 흐름·신호등 갱신값을 받는다. 공용 흐름 화면이 읽는 이름(devFlow)으로 내놓는다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('devFlow', {
  onUpdate: (callback) => { ipcRenderer.on('lab-flow-update', (_event, snapshot) => callback(snapshot)); },
});
