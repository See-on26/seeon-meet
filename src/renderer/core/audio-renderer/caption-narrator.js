import { SIC_CATCHUP_MIN_RATE, SIC_CATCHUP_MAX_RATE, SIC_CATCHUP_RATE_PER_SEC } from '../constants.js';

const START_LEAD_SEC = 0.02;

export function computeCatchupRate({ pausedSec, minRate, maxRate, ratePerSec }) {
  return Math.min(maxRate, Math.max(minRate, minRate + pausedSec * ratePerSec));
}

export class CaptionNarrator {
  constructor({ getLiveVideo, onStatus = null, getRateRange = null, isCatchupDelegated = null }) {
    this.getLiveVideo = getLiveVideo;
    this.onStatus = onStatus || (() => {});
    this.getRateRange = getRateRange
      || (() => ({ rateMin: SIC_CATCHUP_MIN_RATE, rateMax: SIC_CATCHUP_MAX_RATE }));
    this.isCatchupDelegated = isCatchupDelegated || (() => false);
    this.audioContext = null;
    this.ttsGainNode = null;
    this.analyserNode = null;
    this.liveTapSource = null;
    this.currentSource = null;
    this.queueList = [];
    this.isInserting = false;
    this.isCatchingUp = false;
    this.narratedSec = 0;
    this.currentNarrationSec = 0;
    this.catchupTimer = null;
  }

  start(stream) {
    this.audioContext = new AudioContext();
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 1024;

    this.ttsGainNode = this.audioContext.createGain();
    this.ttsGainNode.connect(this.audioContext.destination);
    this.ttsGainNode.connect(this.analyserNode);

    try {
      if (stream.getAudioTracks().length) {
        this.liveTapSource = this.audioContext.createMediaStreamSource(stream);
        this.liveTapSource.connect(this.analyserNode);
      }
    } catch (error) {
      this.onStatus(`파형 탭 실패(무시): ${error.message}`);
    }
  }

  stop() {
    this._cancelCatchup();
    try { this.currentSource?.stop(); } catch {  }
    this.currentSource = null;
    this.queueList = [];
    this.isInserting = false;
    this.narratedSec = 0;
    this.currentNarrationSec = 0;
    const video = this.getLiveVideo();
    if (video) video.playbackRate = 1.0;
    try { this.liveTapSource?.disconnect(); } catch {  }
    this.liveTapSource = null;
    if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }
    this.ttsGainNode = null;
    this.analyserNode = null;
    this.onStatus('');
  }

  queueCaption(wavArrayBuffer) {
    if (!this.audioContext) return;
    this.queueList.push(wavArrayBuffer);
    if (!this.isInserting) this._beginNext();
  }

  async _beginNext() {
    const buffer = this.queueList[0];
    if (!buffer) return;
    if (!this.isInserting) {
      this.isInserting = true;
      this.narratedSec = 0;
      this._cancelCatchup();
      const video = this.getLiveVideo();
      if (video) { video.pause(); video.playbackRate = 1.0; }
    }
    try {
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      const audioBuffer = await this.audioContext.decodeAudioData(buffer);
      this.currentNarrationSec = audioBuffer.duration || 0;
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.ttsGainNode);
      source.onended = () => this._onNarrationEnded();
      this.currentSource = source;
      source.start(this.audioContext.currentTime + START_LEAD_SEC);
      this.onStatus('캡션 내레이션 재생 중…');
    } catch (error) {
      this.onStatus(`내레이션 재생 실패: ${error.message}`);
      this.currentNarrationSec = 0;
      this._onNarrationEnded();
    }
  }

  _onNarrationEnded() {
    this.narratedSec += this.currentNarrationSec;
    this.currentNarrationSec = 0;
    this.queueList.shift();
    this.currentSource = null;
    if (this.queueList.length) { this._beginNext(); return; }
    this.isInserting = false;
    const narratedSec = this.narratedSec;
    this.narratedSec = 0;
    this._startCatchup(narratedSec);
  }

  _startCatchup(pausedSec) {
    const video = this.getLiveVideo();
    if (!video) return;
    video.play().catch(() => {});
    if (this.isCatchupDelegated()) { this.onStatus(''); return; }
    if (pausedSec <= 0.05) { video.playbackRate = 1.0; this.onStatus(''); return; }
    const { rateMin, rateMax } = this.getRateRange();
    const rate = computeCatchupRate({
      pausedSec, minRate: rateMin, maxRate: rateMax, ratePerSec: SIC_CATCHUP_RATE_PER_SEC,
    });

    if (rate <= 1.0) { video.playbackRate = 1.0; this.onStatus(''); return; }
    video.playbackRate = rate;
    this.isCatchingUp = true;
    this.onStatus(`x${rate.toFixed(2)} 따라잡기`);

    const catchupMs = (pausedSec / (rate - 1)) * 1000;
    this.catchupTimer = setTimeout(() => {
      const current = this.getLiveVideo();
      if (current) current.playbackRate = 1.0;
      this.isCatchingUp = false;
      this.catchupTimer = null;
      this.onStatus('');
    }, catchupMs);
  }

  _cancelCatchup() {
    if (this.catchupTimer) { clearTimeout(this.catchupTimer); this.catchupTimer = null; }
    this.isCatchingUp = false;
  }

  getAnalyser() {
    return this.analyserNode;
  }

  getSicState() {
    const video = this.getLiveVideo();
    return {
      isInserting: this.isInserting,
      isCatchingUp: this.isCatchingUp,
      playbackRate: video ? video.playbackRate : 1.0,
    };
  }
}
