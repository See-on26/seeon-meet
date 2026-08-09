import { computeBlockHistogramList, computeMeanBhattacharyyaDistance } from './histogram.js';

const DEFAULT_GRID_ROW_COUNT = 4;
const DEFAULT_GRID_COL_COUNT = 6;
const DEFAULT_BIN_COUNT = 32;
const DEFAULT_MOTION_DISTANCE = 0.008;
const DEFAULT_STILL_DISTANCE = 0.004;
const DEFAULT_SETTLE_SAMPLES = 1;
const DEFAULT_MIN_CHANGE_VS_REF = 0.012;
const DEFAULT_ACCUM_CHANGE_VS_REF = 0.06;
const DEFAULT_FORCE_SAMPLES = 5;

const DEFAULT_COOLDOWN_MS = 1200;

const GATE_STATE_MAP = { still: 'still', moving: 'moving' };

export class SlideHistogramGate {
  constructor({ motionDistance = DEFAULT_MOTION_DISTANCE, stillDistance = DEFAULT_STILL_DISTANCE,
    settleSamples = DEFAULT_SETTLE_SAMPLES, minChangeVsRef = DEFAULT_MIN_CHANGE_VS_REF,
    accumChangeVsRef = DEFAULT_ACCUM_CHANGE_VS_REF, forceSamples = DEFAULT_FORCE_SAMPLES,
    cooldownMs = DEFAULT_COOLDOWN_MS, rowCount = DEFAULT_GRID_ROW_COUNT,
    colCount = DEFAULT_GRID_COL_COUNT, binCount = DEFAULT_BIN_COUNT } = {}) {
    this.motionDistance = motionDistance;
    this.stillDistance = stillDistance;
    this.settleSamples = settleSamples;
    this.minChangeVsRef = minChangeVsRef;
    this.accumChangeVsRef = accumChangeVsRef;
    this.forceSamples = forceSamples;
    this.cooldownMs = cooldownMs;
    this.rowCount = rowCount;
    this.colCount = colCount;
    this.binCount = binCount;
    this.reset();
  }

  reset() {
    this.refHistogramList = null;
    this.prevHistogramList = null;
    this.size = null;
    this.state = GATE_STATE_MAP.still;
    this.stillCount = 0;
    this.motionStreak = 0;
    this.hasForcedInMotion = false;
    this.lastTransitionTs = -Infinity;
    this.lastFrameToFrame = 0;
    this.lastChangeVsRef = 0;
  }

  sample({ imageData, ts }) {
    const histogramList = computeBlockHistogramList({
      imageData, rowCount: this.rowCount, colCount: this.colCount, binCount: this.binCount,
    });
    const size = `${imageData.width}x${imageData.height}`;
    if (this.size !== size || !this.refHistogramList) {
      this.refHistogramList = histogramList;
      this.prevHistogramList = histogramList;
      this.size = size;
      this.state = GATE_STATE_MAP.still;
      this.stillCount = 0;
      this.motionStreak = 0;
      this.hasForcedInMotion = false;
      return { isTransition: false, isFirst: true, changeVsCommitted: 1, streak: 0 };
    }

    const frameToFrame = computeMeanBhattacharyyaDistance({
      histogramListA: this.prevHistogramList, histogramListB: histogramList,
    });
    const changeVsRef = computeMeanBhattacharyyaDistance({
      histogramListA: this.refHistogramList, histogramListB: histogramList,
    });
    this.prevHistogramList = histogramList;
    this.lastFrameToFrame = frameToFrame;
    this.lastChangeVsRef = changeVsRef;

    if (frameToFrame >= this.motionDistance) {
      this.state = GATE_STATE_MAP.moving;
      this.stillCount = 0;
      this.motionStreak += 1;

      const isNeverSettling = this.motionStreak >= this.forceSamples
        && changeVsRef >= this.accumChangeVsRef && !this.hasForcedInMotion;
      if (isNeverSettling && this._isCooledDown(ts)) {
        this.hasForcedInMotion = true;
        return this._emitCandidate({ histogramList, changeVsRef, ts });
      }
      return { isTransition: false, isFirst: false, changeVsCommitted: 1 - changeVsRef, streak: 0 };
    }

    if (frameToFrame <= this.stillDistance) {
      this.motionStreak = 0;
      if (this.state === GATE_STATE_MAP.moving) {
        this.stillCount += 1;
        if (this.stillCount >= this.settleSamples) {
          this.state = GATE_STATE_MAP.still;
          this.hasForcedInMotion = false;
          if (changeVsRef >= this.minChangeVsRef && this._isCooledDown(ts)) {
            return this._emitCandidate({ histogramList, changeVsRef, ts });
          }

          this.refHistogramList = histogramList;
          return { isTransition: false, isFirst: false, changeVsCommitted: 1 - changeVsRef, streak: this.stillCount };
        }
      } else if (changeVsRef >= this.accumChangeVsRef && this._isCooledDown(ts)) {
        return this._emitCandidate({ histogramList, changeVsRef, ts });
      }
    }

    return { isTransition: false, isFirst: false, changeVsCommitted: 1 - changeVsRef, streak: this.stillCount };
  }

  _isCooledDown(ts) {
    return ts - this.lastTransitionTs >= this.cooldownMs;
  }

  _emitCandidate({ histogramList, changeVsRef, ts }) {
    this.refHistogramList = histogramList;
    this.state = GATE_STATE_MAP.still;
    this.lastTransitionTs = ts;
    const streak = this.stillCount;
    this.stillCount = 0;
    this.motionStreak = 0;
    return { isTransition: true, isFirst: false, changeVsCommitted: 1 - changeVsRef, streak };
  }
}
