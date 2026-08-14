import { ASR_SEGMENT_MS } from '../constants.js';

const AUDIO_MIME_TYPE = 'audio/webm;codecs=opus';
const VAD_SAMPLE_MS = 100;
const DEFAULT_VOICE_LEVEL_THRESHOLD = 0.02;
const DEFAULT_MIN_VOICED_MS = 200;

const DEFAULT_SILENCE_CUT_MS = 400;

const DEFAULT_MIN_SEGMENT_MS = 2500;

export function isSegmentVoiced({ voicedMs, minVoicedMs }) {
  return voicedMs >= minVoicedMs;
}

export function isSegmentCutReady({ elapsedMs, silenceMs, minSegmentMs, silenceCutMs }) {
  return elapsedMs >= minSegmentMs && silenceMs >= silenceCutMs;
}

export class AsrSegmenter {
  constructor({ onSegment, onError = null, segmentMs = ASR_SEGMENT_MS,
    getVoiceLevel = null, voiceThreshold = DEFAULT_VOICE_LEVEL_THRESHOLD,
    minVoicedMs = DEFAULT_MIN_VOICED_MS, onSkip = null,
    silenceCutMs = DEFAULT_SILENCE_CUT_MS, minSegmentMs = DEFAULT_MIN_SEGMENT_MS }) {
    this.onSegment = onSegment;
    this.onError = onError;
    this.segmentMs = segmentMs;
    this.silenceCutMs = silenceCutMs;
    this.minSegmentMs = minSegmentMs;
    this.getVoiceLevel = getVoiceLevel;
    this.voiceThreshold = voiceThreshold;
    this.minVoicedMs = minVoicedMs;
    this.onSkip = onSkip;
    this.audioStream = null;
    this.recorder = null;
    this.stopTimer = null;
    this.vadTimer = null;
    this.isRunning = false;

    this.resolveFinalFlush = null;
  }

  setSegmentMs({ segmentMs }) {
    if (Number.isFinite(segmentMs) && segmentMs > 0) this.segmentMs = segmentMs;
  }

  start(stream) {
    const audioTrackList = stream.getAudioTracks();
    if (!audioTrackList.length) return;
    this.audioStream = new MediaStream(audioTrackList);
    this.isRunning = true;
    this._recordNextSegment();
  }

  stop() {
    this.isRunning = false;
    clearTimeout(this.stopTimer);
    if (this.vadTimer) { clearInterval(this.vadTimer); this.vadTimer = null; }
    const recorder = this.recorder;
    this.recorder = null;
    this.audioStream = null;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve();
    const finalFlushPromise = new Promise((resolve) => { this.resolveFinalFlush = resolve; });
    recorder.stop();
    return finalFlushPromise;
  }

  _recordNextSegment() {
    if (!this.isRunning) return;
    const startTs = Date.now();
    const chunkList = [];
    let recorder;
    try {
      recorder = new MediaRecorder(this.audioStream, { mimeType: AUDIO_MIME_TYPE });
    } catch (error) {
      this.onError?.(error);
      return;
    }
    let voicedMs = 0;
    let silenceMs = 0;
    if (this.getVoiceLevel) {
      this.vadTimer = setInterval(() => {
        if (this.getVoiceLevel() >= this.voiceThreshold) {
          voicedMs += VAD_SAMPLE_MS;
          silenceMs = 0;
          return;
        }
        silenceMs += VAD_SAMPLE_MS;

        const isCutReady = voicedMs >= this.minVoicedMs && isSegmentCutReady({
          elapsedMs: Date.now() - startTs, silenceMs,
          minSegmentMs: this.minSegmentMs, silenceCutMs: this.silenceCutMs,
        });
        if (isCutReady && recorder.state !== 'inactive') recorder.stop();
      }, VAD_SAMPLE_MS);
    }
    recorder.ondataavailable = (event) => { if (event.data.size) chunkList.push(event.data); };
    recorder.onstop = async () => {
      const endTs = Date.now();
      if (this.vadTimer) { clearInterval(this.vadTimer); this.vadTimer = null; }
      clearTimeout(this.stopTimer);

      const isVoiced = !this.getVoiceLevel || isSegmentVoiced({ voicedMs, minVoicedMs: this.minVoicedMs });
      try {
        const blob = new Blob(chunkList, { type: AUDIO_MIME_TYPE });
        if (blob.size && isVoiced) this.onSegment({ startTs, endTs, buffer: await blob.arrayBuffer() });
        else if (blob.size) this.onSkip?.({ startTs, endTs, voicedMs });
      } catch (error) {
        this.onError?.(error);
      }

      if (this.resolveFinalFlush) { this.resolveFinalFlush(); this.resolveFinalFlush = null; }
      this._recordNextSegment();
    };
    recorder.start();
    this.recorder = recorder;
    this.stopTimer = setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, this.segmentMs);
  }
}
