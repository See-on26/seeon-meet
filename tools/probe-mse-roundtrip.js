// MediaRecorder(opus) → MediaSource → <audio> 왕복이 실제로 재생·배속되는지 확인한다.
// 설계 문서 §12: 이 왕복이 깨지면 StreamDelaySource 구조 전체가 성립하지 않는다.
//
// isTypeSupported가 true인 것과 왕복이 재생되는 것은 다른 문제다 — MediaRecorder의 WebM 출력은
// duration이 미확정(0xFFFFFFFF)이라 MSE가 거부하거나 buffered가 이상하게 잡히는 사례가 알려져 있다.
//
// 실행: npx electron tools/probe-mse-roundtrip.js
const { app, BrowserWindow } = require('electron');

// 캡처 권한이 필요 없도록 오실레이터로 진짜 오디오 MediaStream을 만든다 —
// getDisplayMedia는 사용자 제스처와 피커가 필요해 무인 실행이 안 된다.
const PROBE_HTML = 'data:text/html,<!doctype html><meta charset="utf-8"><body></body>';

const PROBE_SCRIPT = `(async () => {
  const MIME_TYPE = 'audio/webm;codecs=opus';
  const TIMESLICE_MS = 200;
  const result = {
    isRecorderSupported: MediaRecorder.isTypeSupported(MIME_TYPE),
    isSourceSupported: MediaSource.isTypeSupported(MIME_TYPE),
    appendedChunkCount: 0,
    bufferedEndSec: 0,
    playheadSec: 0,
    isRateApplied: false,
    error: null,
  };
  try {
    const audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = 440;
    oscillator.connect(destination);
    oscillator.start();

    const mediaSource = new MediaSource();
    const element = document.createElement('audio');
    element.src = URL.createObjectURL(mediaSource);
    document.body.appendChild(element);

    const sourceBuffer = await new Promise((resolve) => {
      mediaSource.addEventListener('sourceopen', () => {
        const buffer = mediaSource.addSourceBuffer(MIME_TYPE);
        buffer.mode = 'sequence';
        resolve(buffer);
      }, { once: true });
    });

    const queueList = [];
    let isDraining = false;
    const drain = () => {
      if (isDraining || sourceBuffer.updating || !queueList.length) return;
      isDraining = true;
      sourceBuffer.appendBuffer(queueList.shift());
      result.appendedChunkCount += 1;
    };
    sourceBuffer.addEventListener('updateend', () => { isDraining = false; drain(); });

    const recorder = new MediaRecorder(destination.stream, { mimeType: MIME_TYPE });
    recorder.addEventListener('dataavailable', async (event) => {
      if (!event.data || !event.data.size) return;
      queueList.push(await event.data.arrayBuffer());
      drain();
    });
    recorder.start(TIMESLICE_MS);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    await element.play();
    element.playbackRate = 1.5;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    recorder.stop();
    result.bufferedEndSec = sourceBuffer.buffered.length
      ? sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) : 0;
    result.playheadSec = element.currentTime;
    result.isRateApplied = element.playbackRate === 1.5;
  } catch (error) {
    result.error = error.name + ': ' + error.message;
  }
  return result;
})()`;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  await window.loadURL(PROBE_HTML);
  const result = await window.webContents.executeJavaScript(PROBE_SCRIPT);

  const isPass = result.error === null
    && result.isRecorderSupported && result.isSourceSupported
    && result.appendedChunkCount > 0 && result.bufferedEndSec > 1 && result.playheadSec > 0
    && result.isRateApplied;

  console.log(JSON.stringify(result, null, 2));
  console.log(isPass ? '[probe] PASS' : '[probe] FAIL');
  app.exit(isPass ? 0 : 1);
});
