export const CANDIDATE_SOURCE_MAP = {
  speech: 'speech',
  pointing: 'pointing',
};

const DEFAULT_LOOKAHEAD_MS = 2500;
const DEFAULT_COOLDOWN_MS = 4000;

export class DeixisCandidateScheduler {
  constructor({ onDecide, lookaheadMs = DEFAULT_LOOKAHEAD_MS, cooldownMs = DEFAULT_COOLDOWN_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => clearTimeout(handle) }) {
    this.onDecide = onDecide;
    this.lookaheadMs = lookaheadMs;
    this.cooldownMs = cooldownMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = null;
    this.timerHandle = null;
    this.lastDecidedAt = -Infinity;
  }

  setLookaheadMs({ lookaheadMs }) {
    if (Number.isFinite(lookaheadMs) && lookaheadMs >= 0) this.lookaheadMs = lookaheadMs;
  }

  submit({ source, utterance = '', trigger = '', region = null, pointingOrderHint = '',
    captureTs, videoTimeMs }) {
    if (this.pending) {
      this.absorb({ utterance, trigger, region, pointingOrderHint });
      return;
    }
    if (captureTs - this.lastDecidedAt < this.cooldownMs) return;
    this.pending = {
      source, utterance, triggerList: trigger ? [trigger] : [],
      region, pointingOrderHint, captureTs, videoTimeMs,
    };
    this.timerHandle = this.setTimer(() => this.fire(), this.lookaheadMs);
  }

  absorb({ utterance, trigger, region, pointingOrderHint }) {
    if (!this.pending.utterance && utterance) this.pending.utterance = utterance;
    if (trigger && !this.pending.triggerList.includes(trigger)) this.pending.triggerList.push(trigger);
    if (!this.pending.region && region) this.pending.region = region;
    if (!this.pending.pointingOrderHint && pointingOrderHint) this.pending.pointingOrderHint = pointingOrderHint;
  }

  fire() {
    const decision = this.pending;
    this.pending = null;
    this.timerHandle = null;
    this.lastDecidedAt = decision.captureTs;
    this.onDecide?.(decision);
  }

  reset() {
    if (this.timerHandle !== null) { this.clearTimer(this.timerHandle); this.timerHandle = null; }
    this.pending = null;
    this.lastDecidedAt = -Infinity;
  }
}
