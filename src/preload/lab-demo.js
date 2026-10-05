// 시연 창 preload. 재생이 시작된 해설 카드를 받는다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('labDemo', {
  onCard: (callback) => { ipcRenderer.on('lab-demo-card', (_event, card) => callback(card)); },
});
