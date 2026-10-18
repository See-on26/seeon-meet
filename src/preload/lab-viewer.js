// 실험 창의 production 화면 preload. production viewer preload 가 노출한 API 를 모두 그대로 노출하고,
// window.seeon 에 실험용 알림(재생 시작·자막 창)을 덧붙이며 세션 시작에 이번 실행의 받아쓰기 언어를 싣는다.
// 페이지 스크립트보다 먼저 기능 토글과 이번 실행의 캡션 언어를 써 넣는다(viewer 는 둘 다 페이지를 불러올 때 한 번 읽는다).
const { contextBridge, ipcRenderer } = require('electron');
const { captureExposedApi, exposeCapturedApi } = require('./lab/capture-exposed-api');
const { toForwardedPipelineEvent, buildPlaybackReport } = require('./lab/forward-event');
const { applyFeatureTogglePreset } = require('../main/lab/feature-toggle-preset');
const { applyCaptionLanguagePreset } = require('../main/lab/meeting-language-preset');

const capturedMap = captureExposedApi({ contextBridge, load: () => require('./viewer.js') });

// 받아쓰기 언어를 실을 곳이 없으면 제품 기본(자동)으로 조용히 돌지 않게 아무것도 노출하기 전에 멈춘다.
if (capturedMap.seeon && typeof capturedMap.seeon.startPipelineSession !== 'function') {
  throw new Error('[lab] production viewer preload 의 window.seeon 에 startPipelineSession 이 없다 — 받아쓰기 언어를 실을 수 없다');
}

exposeCapturedApi({
  contextBridge,
  capturedMap,
  extensionMap: {
    seeon: {
      // 제품 화면은 받아쓰기 언어를 보내지 않는다(늘 자동). 실험은 이번 실행에 고른 받아쓰기 언어를 덧붙여
      // main 이 그 언어로 전사하게 한다. 나머지 값(모드·캡션 언어·화면 글자)은 제품 화면이 보낸 그대로다.
      startPipelineSession(args) {
        return capturedMap.seeon.startPipelineSession({ ...args, asrLanguage: ipcRenderer.sendSync('lab-viewer-meeting-language') });
      },
      reportLabNarrationPlayback(info) {
        ipcRenderer.send('lab-narration-playback', buildPlaybackReport(info));
      },
      // 자막 창용: 받아쓰기 조각과 들은 위치·재생 속도.
      reportLabTranscript(info) {
        ipcRenderer.send('lab-transcript', info);
      },
      reportLabListen(info) {
        ipcRenderer.send('lab-listen', info);
      },
    },
  },
});

applyFeatureTogglePreset({ storage: window.localStorage, presetMap: ipcRenderer.sendSync('lab-viewer-preset') });
applyCaptionLanguagePreset({ storage: window.localStorage, language: ipcRenderer.sendSync('lab-viewer-caption-language') });

// 이 listener 는 production 화면의 onPipelineEvent listener 보다 먼저 붙는다. 여기서 던지면 같은 이벤트가
// production 화면에 가지 않으므로, 실험 기록으로 넘기다 실패한 것은 알리기만 하고 삼킨다.
ipcRenderer.on('pipeline-event', (_event, payload) => {
  try {
    const forwarded = toForwardedPipelineEvent(payload);
    if (forwarded) ipcRenderer.send('lab-viewer-event', forwarded);
  } catch (error) {
    console.warn('[lab] pipeline-event 를 실험 기록으로 넘기지 못했다(production 화면은 그대로 받는다):', error?.message || error);
  }
});
