// 실험 재생 화면 preload. ROI·시각 보고·viewer 소리 녹음 조각을 main 으로 보낸다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('labPlayerBridge', {
  sendRoiUpdate(payload) { ipcRenderer.send('roi-update', payload); },
  reportTime(report) { ipcRenderer.send('lab-player-time', report); },
  sendOutputChunk({ buffer }) { return ipcRenderer.invoke('lab-output-chunk', { buffer: new Uint8Array(buffer) }); },
  reportOutputState(state) { ipcRenderer.send('lab-output-state', state); },
  reportError(message) { ipcRenderer.send('lab-player-error', { message: String(message) }); },
});
