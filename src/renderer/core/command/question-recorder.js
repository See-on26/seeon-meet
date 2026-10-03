export const RECORDER_STOP_REASON_MAP = {
  manual: 'manual',
  silence: 'silence',
  maxLength: 'max_length',
  noVoice: 'no_voice',
  cancelled: 'cancelled',
};

const MIN_VOICED_MS = 200;
const SILENCE_STOP_MS = 1500;
const MAX_RECORDING_MS = 15000;
const SAMPLE_MS = 100;
const VOICE_LEVEL_THRESHOLD = 0.02;
const AUDIO_MIME_TYPE = 'audio/webm;codecs=opus';

export function resolveRecorderStop({ elapsedMs, voicedMs, silenceMs, isToggled }) {
  const hasVoice = voicedMs >= MIN_VOICED_MS;
  if (isToggled) return hasVoice ? RECORDER_STOP_REASON_MAP.manual : RECORDER_STOP_REASON_MAP.noVoice;
  if (elapsedMs >= MAX_RECORDING_MS) {
    return hasVoice ? RECORDER_STOP_REASON_MAP.maxLength : RECORDER_STOP_REASON_MAP.noVoice;
  }
  if (hasVoice && silenceMs >= SILENCE_STOP_MS) return RECORDER_STOP_REASON_MAP.silence;
  return null;
}

function computeRms(analyser, sampleBuffer) {
  analyser.getFloatTimeDomainData(sampleBuffer);
  let sum = 0;
  for (const value of sampleBuffer) sum += value * value;
  return Math.sqrt(sum / sampleBuffer.length);
}

// 사용자 마이크만 녹음한다(Meet 회의 소리와 별개). 끝나면 webm 버퍼를 넘기고, 말이 없었거나 취소되면 취소를 알린다.
export class QuestionRecorder {
  constructor({ onFinish, onCancel, getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    now = () => performance.now() }) {
    this.onFinish = onFinish;
    this.onCancel = onCancel;
    this.getUserMedia = getUserMedia;
    this.now = now;
    this.isRecording = false;
    this.isToggled = false;
    this.stopReason = null;
  }

  async start() {
    if (this.isRecording) return false;
    let stream;
    try {
      stream = await this.getUserMedia({ audio: true });
    } catch (error) {
      this.onCancel?.({ reason: 'permission', message: error.message });
      return false;
    }
    // 준비 중 하나라도 실패하면 마이크를 닫고 취소를 알린다. 열린 채 남으면 보류 게이트와 Meet 마이크가 풀리지 않는다.
    try {
      this.setUp(stream);
    } catch (error) {
      this.tearDown();
      this.onCancel?.({ reason: 'error', message: error.message });
      return false;
    }
    return true;
  }

  setUp(stream) {
    this.stream = stream;
    this.isToggled = false;
    this.stopReason = null;
    this.startTs = Date.now();
    this.startedAt = this.now();
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.chunkList = [];
    this.audioContext = new AudioContext();
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 1024;
    this.audioContext.createMediaStreamSource(stream).connect(analyser);
    const sampleBuffer = new Float32Array(analyser.fftSize);
    this.recorder = new MediaRecorder(stream, { mimeType: AUDIO_MIME_TYPE });
    this.recorder.ondataavailable = (event) => { if (event.data.size) this.chunkList.push(event.data); };
    this.recorder.onstop = () => { this.finish(); };
    this.recorder.start();
    this.isRecording = true;
    this.sampleTimer = setInterval(() => {
      if (computeRms(analyser, sampleBuffer) >= VOICE_LEVEL_THRESHOLD) {
        this.voicedMs += SAMPLE_MS;
        this.silenceMs = 0;
      } else {
        this.silenceMs += SAMPLE_MS;
      }
      this.checkStop();
    }, SAMPLE_MS);
  }

  tearDown() {
    clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    this.isRecording = false;
    for (const track of this.stream?.getTracks?.() || []) track.stop();
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
  }

  toggle() {
    if (!this.isRecording) return this.start();
    this.isToggled = true;
    this.checkStop();
    return Promise.resolve(false);
  }

  cancel() {
    if (!this.isRecording) return;
    this.requestStop(RECORDER_STOP_REASON_MAP.cancelled);
  }

  checkStop() {
    const reason = resolveRecorderStop({
      elapsedMs: this.now() - this.startedAt, voicedMs: this.voicedMs,
      silenceMs: this.silenceMs, isToggled: this.isToggled,
    });
    if (reason) this.requestStop(reason);
  }

  requestStop(reason) {
    if (this.stopReason) return;
    this.stopReason = reason;
    clearInterval(this.sampleTimer);
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    else this.finish();
  }

  async finish() {
    const reason = this.stopReason || RECORDER_STOP_REASON_MAP.cancelled;
    this.stopReason = null;
    const chunkList = this.chunkList;
    this.tearDown();
    if (reason === RECORDER_STOP_REASON_MAP.noVoice || reason === RECORDER_STOP_REASON_MAP.cancelled) {
      this.onCancel?.({ reason });
      return;
    }
    try {
      const blob = new Blob(chunkList, { type: AUDIO_MIME_TYPE });
      this.onFinish?.({ buffer: await blob.arrayBuffer(), startTs: this.startTs, reason });
    } catch (error) {
      this.onCancel?.({ reason: 'error', message: error.message });
    }
  }
}
