const DEFAULT_DELAY_TOLERANCE_MS = 300;

const DEFAULT_REBUFFER_TOLERANCE_MS = 1500;

// 지연 0 인 성능 모드도 받아 둔 소리를 이만큼 남긴다. 지연 재생은 0.2초 조각을 MSE 로 받아 트는데, 0.3초만 두면
// 따라잡기 배속(1.5배)이 버퍼 끝에 닿아 Chromium 이 데이터를 다시 모으며 3초가량 멈추기를 되풀이한다(67초에 7번).
export const MIN_HEADROOM_MS = 1000;

export function computeActualDelayMs({ liveTimeMs, delayedTimeMs }) {
  return liveTimeMs - delayedTimeMs;
}

export function isDelayRestored({ actualDelayMs, targetDelayMs, toleranceMs = DEFAULT_DELAY_TOLERANCE_MS }) {
  return Math.abs(actualDelayMs - targetDelayMs) <= toleranceMs;
}

// 따라잡기 끝에서 배속을 1.0배까지 부드럽게 내리는 시간. 남은 지연을 다 메우는 순간 1.0배가 되게, 지금 배속 r₀ 에서
// 1.0배까지 이 시간 동안 곧게 내릴 때 메우는 지연 (r-1)²·T / (2(r₀-1)) 을 거꾸로 풀어 배속을 정한다.
// 예전처럼 남은 지연에 비례해 낮추기만 하면 끝에서 1.1배 꼬리가 길었다(균형 모드 6초 해설 → 따라잡기 20초, 그중 1.2배 미만 7초).
export const CATCHUP_RAMP_SEC = 1.0;

export function computeCatchupRate({ excessMs, rateMin, rateMax, ratePerSec = 0.1, rampSec = CATCHUP_RAMP_SEC }) {
  if (excessMs <= 0) return 1.0;
  const excessSec = excessMs / 1000;
  const bodyRate = Math.min(rateMax, Math.max(rateMin, rateMin + excessSec * ratePerSec));
  const rampRate = 1 + Math.sqrt(2 * (bodyRate - 1) * excessSec / rampSec);
  return Math.min(bodyRate, rampRate);
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
