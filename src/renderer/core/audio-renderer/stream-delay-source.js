
const DEFAULT_MIME_TYPE = 'audio/webm;codecs=opus';

const DEFAULT_TIMESLICE_MS = 200;

const RETAIN_FACTOR = 3;

const MIN_RETAIN_MS = 30000;

const PRUNE_INTERVAL_MS = 5000;

export function computeRetainMs({ targetDelayMs, retainFactor = RETAIN_FACTOR, minRetainMs = MIN_RETAIN_MS }) {
  return Math.max(minRetainMs, targetDelayMs * retainFactor);
}

export function computePruneEndSec({ playheadSec, retainMs }) {
  return Math.max(0, playheadSec - retainMs / 1000);
}

export function readBufferedEndMs({ buffered }) {
  if (!buffered || !buffered.length) return 0;
  return buffered.end(buffered.length - 1) * 1000;
}

export class StreamDelaySource {
  constructor({
    stream, getVideoTimeMs, targetDelayMs,
    mimeType = DEFAULT_MIME_TYPE, timesliceMs = DEFAULT_TIMESLICE_MS,
    createAudioStream = (trackList) => new MediaStream(trackList),
    createRecorder = (mediaStream, options) => new MediaRecorder(mediaStream, options),
    createMediaSource = () => new MediaSource(),
    createElement = () => document.createElement('audio'),
    createObjectUrl = (source) => URL.createObjectURL(source),
    revokeObjectUrl = (url) => URL.revokeObjectURL(url),
    setTimer = (fn, ms) => setInterval(fn, ms),
    clearTimer = (handle) => clearInterval(handle),
    onError = null,
  }) {
    this.stream = stream;
    this.getVideoTimeMs = getVideoTimeMs;
    this.targetDelayMs = targetDelayMs;
    this.mimeType = mimeType;
    this.timesliceMs = timesliceMs;
    this.createAudioStream = createAudioStream;
    this.createRecorder = createRecorder;
    this.createMediaSource = createMediaSource;
    this.createElement = createElement;
    this.createObjectUrl = createObjectUrl;
    this.revokeObjectUrl = revokeObjectUrl;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onError = onError || (() => {});
    this.retainMs = computeRetainMs({ targetDelayMs });

    this.recorder = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.element = null;
    this.objectUrl = null;
    this.chunkQueueList = [];
    this.pruneTimerHandle = null;
    this.isQuotaRetried = false;
    this.recorderStartVideoTimeMs = 0;
  }

  start({ fromTimeMs = null } = {}) {
    this.recorderStartVideoTimeMs = this.getVideoTimeMs();
    this.mediaSource = this.createMediaSource();
    this.element = this.createElement();
    this.objectUrl = this.createObjectUrl(this.mediaSource);
    this.element.src = this.objectUrl;
    this.mediaSource.addEventListener('sourceopen', () => this.handleSourceOpen(), { once: true });

    const audioStream = this.createAudioStream(this.stream.getAudioTracks());
    this.recorder = this.createRecorder(audioStream, { mimeType: this.mimeType });
    this.recorder.addEventListener('dataavailable', (event) => this.handleDataAvailable(event));
    this.recorder.addEventListener('error', (event) => this.handleRecorderError(event));
    this.recorder.start(this.timesliceMs);

    this.pruneTimerHandle = this.setTimer(() => this.prune(), PRUNE_INTERVAL_MS);
    return this.element;
  }

  handleSourceOpen() {
    this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeType);
    this.sourceBuffer.mode = 'sequence';
    this.sourceBuffer.addEventListener('updateend', () => this.drainQueue());
    this.drainQueue();
  }

  handleDataAvailable(event) {
    if (!event.data || !event.data.size) return;
    event.data.arrayBuffer()
      .then((arrayBuffer) => { this.chunkQueueList.push(arrayBuffer); this.drainQueue(); })
      .catch((error) => this.handleRecorderError(error));
  }

  drainQueue() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || !this.chunkQueueList.length) return;
    const arrayBuffer = this.chunkQueueList.shift();
    try {
      this.sourceBuffer.appendBuffer(arrayBuffer);
    } catch (error) {
      if (error.name === 'QuotaExceededError' && !this.isQuotaRetried) {
        this.isQuotaRetried = true;
        this.chunkQueueList.unshift(arrayBuffer);
        this.prune({ isForced: true });
        return;
      }
      this.handleRecorderError(error);
    }
  }

  prune({ isForced = false } = {}) {
    if (!this.sourceBuffer || this.sourceBuffer.updating || !this.element) return;
    const endSec = computePruneEndSec({
      playheadSec: this.element.currentTime,
      retainMs: isForced ? this.retainMs / 2 : this.retainMs,
    });
    if (endSec <= 0) return;
    try {
      this.sourceBuffer.remove(0, endSec);
    } catch (error) {
      this.handleRecorderError(error);
    }
  }

  handleRecorderError(error) {
    this.onError({
      reason: '지연 버퍼 오류',
      detail: `${error?.name || 'Error'}: ${error?.message || String(error)}`,
    });
  }

  getElement() {
    return this.element;
  }

  getLiveTimeMs() {
    if (!this.sourceBuffer) return this.recorderStartVideoTimeMs;
    return readBufferedEndMs({ buffered: this.sourceBuffer.buffered }) + this.recorderStartVideoTimeMs;
  }

  getPlayheadMs() {
    if (!this.element) return this.recorderStartVideoTimeMs;
    return this.element.currentTime * 1000 + this.recorderStartVideoTimeMs;
  }

  isReady() {
    return Boolean(this.sourceBuffer);
  }

  getDriftMs() {
    const wallElapsedMs = this.getVideoTimeMs() - this.recorderStartVideoTimeMs;
    const mediaElapsedMs = readBufferedEndMs({ buffered: this.sourceBuffer?.buffered });
    return wallElapsedMs - mediaElapsedMs;
  }

  stop() {
    if (this.pruneTimerHandle !== null) { this.clearTimer(this.pruneTimerHandle); this.pruneTimerHandle = null; }
    try { if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop(); } catch {  }
    this.recorder = null;
    try { if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream(); } catch {  }
    this.element?.pause();
    if (this.objectUrl) { this.revokeObjectUrl(this.objectUrl); this.objectUrl = null; }
    this.element = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.chunkQueueList = [];
  }
}
