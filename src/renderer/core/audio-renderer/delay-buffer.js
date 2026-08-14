const DEFAULT_DELAY_TOLERANCE_MS = 300;

const DEFAULT_REBUFFER_TOLERANCE_MS = 1500;

export const MIN_HEADROOM_MS = 300;

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

export const EXCESS_DROP_MS = 6000;

export function isCaptionDroppable({ excessMs, dropThresholdMs }) {
  return excessMs > dropThresholdMs;
}

export class DelayBuffer {
  constructor({ source, targetDelayMs, rateMin, rateMax,
    setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = (handle) => clearInterval(handle),
    onBufferChange = null }) {
    this.source = source;
    this.targetDelayMs = targetDelayMs;
    this.effectiveTargetMs = Math.max(targetDelayMs, MIN_HEADROOM_MS);
    this.rateMin = rateMin;
    this.rateMax = rateMax;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onBufferChange = onBufferChange || (() => {});
    this.delayedVideo = null;
    this.timerHandle = null;
    this.isHolding = false;
    this.isBuffering = false;
  }

  start({ fromTimeMs = null } = {}) {
    this.delayedVideo = this.source.start({ fromTimeMs });
    if (this.getActualDelayMs() >= this.effectiveTargetMs) this._resumePlayback();
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
    return Math.max(0, this.effectiveTargetMs - this.getActualDelayMs());
  }

  getActualDelayMs() {
    if (!this.delayedVideo) return 0;
    return computeActualDelayMs({
      liveTimeMs: this.source.getLiveTimeMs(),
      delayedTimeMs: this.source.getPlayheadMs(),
    });
  }

  getExcessMs() {
    return this.getActualDelayMs() - this.effectiveTargetMs;
  }

  getDelayedTimeMs() {
    return this.delayedVideo ? this.source.getPlayheadMs() : 0;
  }

  tick() {
    if (!this.delayedVideo || this.isHolding) return;
    if (!this.source.isReady()) return;
    const excessMs = this.getExcessMs();
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
    this.source.stop();
    this.delayedVideo = null;
    this.isHolding = false;
    this.isBuffering = false;
  }
}
