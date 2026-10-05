// 실험 창의 production 화면 preload. window.seeon 은 production viewer preload 와 같고,
// 재생 시작 알림(reportLabNarrationPlayback)만 덧붙인다. 페이지 스크립트보다 먼저 기능 토글을 써 넣는다.
const { contextBridge, ipcRenderer } = require('electron');
const { captureExposedApi } = require('./lab/capture-exposed-api');
const { toForwardedPipelineEvent, buildPlaybackReport } = require('./lab/forward-event');
const { applyFeatureTogglePreset } = require('../main/lab/feature-toggle-preset');

const capturedMap = captureExposedApi({ contextBridge, load: () => require('./viewer.js') });

applyFeatureTogglePreset({ storage: window.localStorage, presetMap: ipcRenderer.sendSync('lab-viewer-preset') });

ipcRenderer.on('pipeline-event', (_event, payload) => {
  const forwarded = toForwardedPipelineEvent(payload);
  if (forwarded) ipcRenderer.send('lab-viewer-event', forwarded);
});

contextBridge.exposeInMainWorld('seeon', {
  ...capturedMap.seeon,
  reportLabNarrationPlayback(info) {
    ipcRenderer.send('lab-narration-playback', buildPlaybackReport(info));
  },
});
