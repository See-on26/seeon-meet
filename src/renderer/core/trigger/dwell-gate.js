import { DWELL_MS } from '../mode/mode-policy.js';

export class DwellGate {
  constructor({ onDwell, dwellMs = DWELL_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => clearTimeout(handle) }) {
    this.onDwell = onDwell;
    this.dwellMs = dwellMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.currentKey = null;
    this.timerHandle = null;
  }

  enter({ key, payload = null }) {
    if (key === this.currentKey && this.timerHandle !== null) return;
    this.cancel();
    this.currentKey = key;
    this.timerHandle = this.setTimer(() => {
      this.timerHandle = null;
      this.onDwell?.({ key, payload });
    }, this.dwellMs);
  }

  cancel() {
    if (this.timerHandle !== null) { this.clearTimer(this.timerHandle); this.timerHandle = null; }
  }

  get isPending() {
    return this.timerHandle !== null;
  }

  getCurrentKey() {
    return this.currentKey;
  }

  reset() {
    this.cancel();
    this.currentKey = null;
  }
}
