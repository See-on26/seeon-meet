// 실험 조작 바 preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('labControl', {
  pickVideo: () => ipcRenderer.invoke('lab-pick-video'),
  start: (option) => ipcRenderer.invoke('lab-start', option),
  pause: () => ipcRenderer.invoke('lab-pause'),
  resume: () => ipcRenderer.invoke('lab-resume'),
  stop: () => ipcRenderer.invoke('lab-stop'),
  setRoiEditing: ({ isEditing }) => ipcRenderer.invoke('lab-roi-edit', { isEditing }),
  openResult: () => ipcRenderer.invoke('lab-open-result'),
  openDemo: () => ipcRenderer.invoke('lab-open-demo'),
  getStatus: () => ipcRenderer.invoke('lab-status'),
  onStatus: (callback) => { ipcRenderer.on('lab-status', (_event, status) => callback(status)); },
});
