// 자막 창 preload. 들린 순간의 회의 소리·AD 자막 줄을 받는다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('labSubtitle', {
  onLine: (callback) => { ipcRenderer.on('lab-subtitle-line', (_event, line) => callback(line)); },
});
