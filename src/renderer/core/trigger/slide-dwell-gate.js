import { DwellGate } from './dwell-gate.js';
import { DWELL_MS } from '../mode/mode-policy.js';

export const DWELL_STATE_MAP = {
  waiting: 'waiting',
  satisfied: 'satisfied',
  cancelled: 'cancelled',
  unknown: 'unknown',
};

export class SlideDwellGate {
  constructor({ onSatisfied = null, onCancelled = null, dwellMs = DWELL_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => clearTimeout(handle) } = {}) {
    this.onSatisfied = onSatisfied || (() => {});
    this.onCancelled = onCancelled || (() => {});
    this.dwellMs = dwellMs;
    this.stateMap = new Map();
    this.resolverMap = new Map();
    this.currentEntry = null;
    this.gate = new DwellGate({
      dwellMs,
      setTimer,
      clearTimer,
      onDwell: ({ payload }) => this._settle({ label: payload.label, isSatisfied: true, isRevisit: payload.isRevisit }),
    });
  }

  enter({ label, isRevisit = false }) {
    if (this.currentEntry && this.currentEntry.label !== label
      && this.stateMap.get(this.currentEntry.label) === DWELL_STATE_MAP.waiting) {
      this.gate.cancel();
      this._settle({ label: this.currentEntry.label, isSatisfied: false, isRevisit: this.currentEntry.isRevisit });
    }
    if (this.stateMap.get(label) === DWELL_STATE_MAP.waiting) return;
    this.currentEntry = { label, isRevisit };
    this.stateMap.set(label, DWELL_STATE_MAP.waiting);
    this.gate.enter({ key: `slide:${label}`, payload: { label, isRevisit } });
  }

  getState({ label }) {
    return this.stateMap.get(label) || DWELL_STATE_MAP.unknown;
  }

  whenResolved({ label, callback }) {
    const state = this.getState({ label });
    if (state === DWELL_STATE_MAP.satisfied) { callback(true); return; }
    if (state !== DWELL_STATE_MAP.waiting) { callback(false); return; }
    if (!this.resolverMap.has(label)) this.resolverMap.set(label, []);
    this.resolverMap.get(label).push(callback);
  }

  _settle({ label, isSatisfied, isRevisit }) {
    this.stateMap.set(label, isSatisfied ? DWELL_STATE_MAP.satisfied : DWELL_STATE_MAP.cancelled);
    const resolverList = this.resolverMap.get(label) || [];
    this.resolverMap.delete(label);
    for (const resolve of resolverList) resolve(isSatisfied);
    if (isSatisfied) this.onSatisfied({ label, isRevisit });
    else this.onCancelled({ label, isRevisit });
  }

  reset() {
    this.gate.reset();
    for (const [, resolverList] of this.resolverMap) {
      for (const resolve of resolverList) resolve(false);
    }
    this.resolverMap.clear();
    this.stateMap.clear();
    this.currentEntry = null;
  }
}
