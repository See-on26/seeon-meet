// 화면 공유 선택 창 preload. main 이 모은 화면·창 목록을 받고, 고른 것의 id(취소면 null)를 돌려준다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sharePicker', {
  getSourceList: () => ipcRenderer.invoke('share-picker-list'),
  choose: (id) => ipcRenderer.invoke('share-picker-choose', { id }),
});
