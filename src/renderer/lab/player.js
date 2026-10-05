import { computeContainRect, FULL_NORM_RECT } from './player/roi-geometry.js';
import { buildLabRoiPayload, buildTimeReport } from './player/player-report.js';
import { RoiEditOverlay } from './player/roi-edit-overlay.js';

const ROI_REPORT_MS = 500;
const TIME_REPORT_MS = 200;
const OUTPUT_MIME_TYPE = 'audio/webm;codecs=opus';
const OUTPUT_TIMESLICE_MS = 1000;
// 기본 화면 캡처 소리는 모노에 에코 제거·잡음 억제·자동 음량이 걸린다. 동시 모드는 해설 왼쪽·회의 오른쪽으로 나눠 들려주므로
// 사람 평가용 녹음은 스테레오로, 소리 처리 없이 받는다.
const OUTPUT_AUDIO_CONSTRAINT = { channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false };

const video = document.getElementById('labVideo');
const bridge = window.labPlayerBridge;
let roiNormRect = FULL_NORM_RECT;
let outputRecorder = null;
let outputChunkChain = Promise.resolve();

const getViewport = () => ({ vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio });
const getContentRect = () => computeContainRect({
  boxWidth: window.innerWidth, boxHeight: window.innerHeight, mediaWidth: video.videoWidth, mediaHeight: video.videoHeight,
});

const roiOverlay = new RoiEditOverlay({
  canvas: document.getElementById('roiEditCanvas'),
  getContentRect,
  getRoiNormRect: () => roiNormRect,
  onChange: (rect) => { roiNormRect = rect; },
});

function reportTime() {
  bridge.reportTime(buildTimeReport({ video, nowMs: Date.now() }));
}

setInterval(() => {
  const contentRect = getContentRect();
  if (contentRect) bridge.sendRoiUpdate(buildLabRoiPayload({ nowMs: Date.now(), viewport: getViewport(), contentRect, roiNormRect }));
}, ROI_REPORT_MS);
setInterval(reportTime, TIME_REPORT_MS);
for (const eventName of ['play', 'pause', 'ended', 'seeked']) video.addEventListener(eventName, reportTime);
video.addEventListener('error', () => bridge.reportError(`영상 재생 오류: ${video.error?.message || video.error?.code || '알 수 없음'}`));

function load({ fileUrl }) {
  return new Promise((resolve, reject) => {
    const handleLoaded = () => {
      video.removeEventListener('error', handleError);
      video.currentTime = 0;
      resolve({
        durationMs: Math.round(video.duration * 1000), videoWidth: video.videoWidth, videoHeight: video.videoHeight,
        viewport: getViewport(),
      });
    };
    const handleError = () => {
      video.removeEventListener('loadeddata', handleLoaded);
      reject(new Error(video.error?.message || '영상을 열 수 없다'));
    };
    video.addEventListener('loadeddata', handleLoaded, { once: true });
    video.addEventListener('error', handleError, { once: true });
    video.pause();
    video.src = fileUrl;
    video.load();
  });
}

// viewer 프레임 소리를 녹음한다(재생 화면 세션 처리기가 viewer 를 enableLocalEcho 로 넘긴다). 화면 트랙은 쓰지 않는다.
async function startOutputRecording() {
  if (outputRecorder) throw new Error('이미 녹음 중이다');
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: OUTPUT_AUDIO_CONSTRAINT });
  stream.getVideoTracks().forEach((track) => track.stop());
  const audioTrackList = stream.getAudioTracks();
  if (!audioTrackList.length) throw new Error('viewer 소리 트랙을 받지 못했다');
  const recorder = new MediaRecorder(new MediaStream(audioTrackList), { mimeType: OUTPUT_MIME_TYPE });
  outputChunkChain = Promise.resolve();
  recorder.addEventListener('dataavailable', (event) => {
    if (!event.data?.size) return;
    const blob = event.data;
    outputChunkChain = outputChunkChain
      .then(() => blob.arrayBuffer())
      .then((buffer) => bridge.sendOutputChunk({ buffer }))
      .catch((error) => bridge.reportOutputState({ phase: 'error', message: error.message }));
  });
  const startedWallMs = await new Promise((resolve) => {
    recorder.addEventListener('start', () => resolve(Date.now()), { once: true });
    recorder.start(OUTPUT_TIMESLICE_MS);
  });
  outputRecorder = recorder;
  return { startedWallMs, mimeType: OUTPUT_MIME_TYPE };
}

async function stopOutputRecording() {
  const recorder = outputRecorder;
  outputRecorder = null;
  if (!recorder) return { stoppedWallMs: Date.now() };
  await new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.stop();
  });
  recorder.stream.getTracks().forEach((track) => track.stop());
  await outputChunkChain;
  return { stoppedWallMs: Date.now() };
}

window.labPlayer = {
  load,
  async play() {
    await video.play();
    reportTime();
    return buildTimeReport({ video, nowMs: Date.now() });
  },
  pause() {
    video.pause();
    reportTime();
    return buildTimeReport({ video, nowMs: Date.now() });
  },
  setRoiEditing({ isEditing }) {
    roiOverlay.setEditing(Boolean(isEditing));
    return { roiNormRect, isEditing: Boolean(isEditing) };
  },
  startOutputRecording,
  stopOutputRecording,
  getState() {
    return { ...buildTimeReport({ video, nowMs: Date.now() }), roiNormRect, isRecording: Boolean(outputRecorder) };
  },
};
