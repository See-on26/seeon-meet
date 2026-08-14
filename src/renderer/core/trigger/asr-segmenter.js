import { ASR_SEGMENT_MS } from '../constants.js';

const AUDIO_MIME_TYPE = 'audio/webm;codecs=opus';
const VAD_SAMPLE_MS = 100;
const DEFAULT_VOICE_LEVEL_THRESHOLD = 0.02;
const DEFAULT_MIN_VOICED_MS = 200;

const DEFAULT_SILENCE_CUT_MS = 400;

const DEFAULT_MIN_SEGMENT_MS = 2500;

// 조각 길이가 찼을 때 말하는 도중이면 강제로 자르지 않는다. 잘린 음절은 Whisper 가 버려
// ("…크게 늘" | "다른 지역도…" — "었습니다"가 사라짐) 트리거가 통째로 빠진다.
// 길이를 넘긴 뒤에는 낱말 사이 짧은 쉼에서 자르고, 쉼이 없어도 이만큼 넘으면 자른다.
export const DEFAULT_MAX_EXTEND_MS = 1500;
export const DEFAULT_EXTEND_SILENCE_CUT_MS = 200;

export function isSegmentVoiced({ voicedMs, minVoicedMs }) {
  return voicedMs >= minVoicedMs;
}

export function isSegmentCutReady({ elapsedMs, silenceMs, minSegmentMs, silenceCutMs }) {
  return elapsedMs >= minSegmentMs && silenceMs >= silenceCutMs;
}

export function shouldCutSegment({ elapsedMs, silenceMs, voicedMs, segmentMs, minSegmentMs, silenceCutMs, minVoicedMs,
  hasVad = true, maxExtendMs = DEFAULT_MAX_EXTEND_MS, extendSilenceCutMs = DEFAULT_EXTEND_SILENCE_CUT_MS }) {
  if (!hasVad) return elapsedMs >= segmentMs;
  if (elapsedMs >= segmentMs + maxExtendMs) return true;
  const hasSpeech = voicedMs >= minVoicedMs;
  if (hasSpeech && isSegmentCutReady({ elapsedMs, silenceMs, minSegmentMs, silenceCutMs })) return true;
  if (elapsedMs < segmentMs) return false;
  return !hasSpeech || silenceMs >= extendSilenceCutMs;
}

export class AsrSegmenter {
  constructor({ onSegment, onError = null, segmentMs = ASR_SEGMENT_MS,
    getVoiceLevel = null, voiceThreshold = DEFAULT_VOICE_LEVEL_THRESHOLD,
    minVoicedMs = DEFAULT_MIN_VOICED_MS, onSkip = null,
    silenceCutMs = DEFAULT_SILENCE_CUT_MS, minSegmentMs = DEFAULT_MIN_SEGMENT_MS, maxExtendMs = DEFAULT_MAX_EXTEND_MS }) {
    this.onSegment = onSegment;
    this.onError = onError;
    this.segmentMs = segmentMs;
    this.silenceCutMs = silenceCutMs;
    this.minSegmentMs = minSegmentMs;
    this.maxExtendMs = maxExtendMs;
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

  setSegmentMs({ segmentMs, minSegmentMs = null }) {
    if (Number.isFinite(segmentMs) && segmentMs > 0) this.segmentMs = segmentMs;
    if (Number.isFinite(minSegmentMs) && minSegmentMs > 0) this.minSegmentMs = minSegmentMs;
    this.minSegmentMs = Math.min(this.minSegmentMs, this.segmentMs);
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

        const isCutReady = shouldCutSegment({
          elapsedMs: Date.now() - startTs, silenceMs, voicedMs,
          segmentMs: this.segmentMs, minSegmentMs: this.minSegmentMs, silenceCutMs: this.silenceCutMs,
          minVoicedMs: this.minVoicedMs, maxExtendMs: this.maxExtendMs,
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
    // 말소리 측정이 있으면 길이가 찬 뒤 판단은 위 측정 주기가 하고, 이 타이머는 늘린 상한에서만 자른다.
    this.stopTimer = setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, this.getVoiceLevel ? this.segmentMs + this.maxExtendMs : this.segmentMs);
  }
}
