const DEFAULT_DELAY_TOLERANCE_MS = 300;

const DEFAULT_REBUFFER_TOLERANCE_MS = 1500;

const SEEK_TOLERANCE_MS = 250;

export function computeActualDelayMs({ liveTimeMs, delayedTimeMs }) {
  return liveTimeMs - delayedTimeMs;
}

export function isDelayRestored({ actualDelayMs, targetDelayMs, toleranceMs = DEFAULT_DELAY_TOLERANCE_MS }) {
  return Math.abs(actualDelayMs - targetDelayMs) <= toleranceMs;
}

export function computeCatchupRate({ excessMs, rateMin, rateMax, ratePerSec = 0.1 }) {
  if (excessMs <= 0) return 1.0;
  const excessSec = excessMs / 1000;
  return Math.min(rateMax, Math.max(rateMin, rateMin + excessSec * ratePerSec));
}

export function computeCatchupDurationMs({ excessMs, rate }) {
  if (excessMs <= 0) return 0;
  if (rate <= 1) return Infinity;
  return excessMs / (rate - 1);
}

export function computeInsertWaitMs({ captionCaptureMs, delayedTimeMs }) {
  return Math.max(0, captionCaptureMs - delayedTimeMs);
}

export function isCaptionStale({ captionCaptureMs, delayedTimeMs, staleToleranceMs }) {
  return delayedTimeMs - captionCaptureMs > staleToleranceMs;
}

export class DelayBuffer {
  constructor({ getLiveVideo, targetDelayMs, rateMin, rateMax,
    createVideo = () => document.createElement('video'),
    setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = (handle) => clearInterval(handle),
    onBufferChange = null }) {
    this.getLiveVideo = getLiveVideo;
    this.targetDelayMs = targetDelayMs;
    this.rateMin = rateMin;
    this.rateMax = rateMax;
    this.createVideo = createVideo;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onBufferChange = onBufferChange || (() => {});
    this.delayedVideo = null;
    this.timerHandle = null;
    this.isHolding = false;
    this.isBuffering = false;
  }

  start({ sourceUrl, fromTimeMs = null }) {
    const liveVideo = this.getLiveVideo();
    this.delayedVideo = this.createVideo();
    this.delayedVideo.playsInline = true;
    this.delayedVideo.src = sourceUrl;
    const liveTimeMs = liveVideo ? liveVideo.currentTime * 1000 : 0;
    const startTimeMs = Number.isFinite(fromTimeMs)
      ? Math.max(0, fromTimeMs) : Math.max(0, liveTimeMs - this.targetDelayMs);
    this.startTimeMs = startTimeMs;

    this.delayedVideo.addEventListener?.('loadedmetadata', () => {
      if (Math.abs(this.delayedVideo.currentTime * 1000 - startTimeMs) > SEEK_TOLERANCE_MS) {
        this.delayedVideo.currentTime = startTimeMs / 1000;
      }
    }, { once: true });
    this.delayedVideo.currentTime = startTimeMs / 1000;

    if (liveTimeMs - startTimeMs >= this.targetDelayMs) this._resumePlayback();
    else this._enterBuffering();
    this.timerHandle = this.setTimer(() => this.tick(), 250);
    return this.delayedVideo;
  }

  _enterBuffering() {
    if (this.isBuffering) return;
    this.isBuffering = true;
    this.delayedVideo?.pause();
    if (this.delayedVideo) this.delayedVideo.playbackRate = 1.0;
    this.onBufferChange({ isBuffering: true, remainingMs: this.getBufferRemainingMs() });
  }

  _resumePlayback() {
    this.isBuffering = false;
    this.delayedVideo?.play?.().catch?.(() => {});
    this.onBufferChange({ isBuffering: false, remainingMs: 0 });
  }

  getBufferRemainingMs() {
    return Math.max(0, this.targetDelayMs - this.getActualDelayMs());
  }

  getActualDelayMs() {
    const liveVideo = this.getLiveVideo();
    if (!liveVideo || !this.delayedVideo) return 0;
    return computeActualDelayMs({
      liveTimeMs: liveVideo.currentTime * 1000,
      delayedTimeMs: this.delayedVideo.currentTime * 1000,
    });
  }

  getDelayedTimeMs() {
    return this.delayedVideo ? this.delayedVideo.currentTime * 1000 : 0;
  }

  tick() {
    if (!this.delayedVideo || this.isHolding) return;

    if ((this.delayedVideo.readyState ?? 1) < 1) return;
    const excessMs = this.getActualDelayMs() - this.targetDelayMs;
    if (this.isBuffering) {
      if (excessMs >= 0) this._resumePlayback();
      else this.onBufferChange({ isBuffering: true, remainingMs: -excessMs });
      return;
    }
    if (excessMs < -DEFAULT_REBUFFER_TOLERANCE_MS) { this._enterBuffering(); return; }
    this.delayedVideo.playbackRate = computeCatchupRate({
      excessMs, rateMin: this.rateMin, rateMax: this.rateMax,
    });
  }

  hold() {
    this.isHolding = true;
    this.delayedVideo?.pause();
    if (this.delayedVideo) this.delayedVideo.playbackRate = 1.0;
  }

  release() {
    this.isHolding = false;
    if (this.isBuffering) return;
    this.delayedVideo?.play?.().catch?.(() => {});
  }

  stop() {
    if (this.timerHandle !== null) { this.clearTimer(this.timerHandle); this.timerHandle = null; }
    this.delayedVideo?.pause();
    this.delayedVideo = null;
    this.isHolding = false;
    this.isBuffering = false;
  }
}
