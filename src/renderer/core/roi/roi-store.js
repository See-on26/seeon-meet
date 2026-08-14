import { describeDirection } from '../trigger/pointing-locator.js';
import { ROI_TYPE_MAP } from '../constants.js';

export const SPEAKER_VERDICT_MAP = {
  unique: 'unique',
  multiple: 'multiple',
  selfOnly: 'self_only',
  none: 'none',
  stale: 'stale',
};

export const ROI_STORE_DEFAULT_MAP = {
  materialIou: 0.92,
  settleMs: 700,
  absenceSettleMs: 1500,
  staleMs: 2000,
  tieBreakMs: 500,
};

function clampNormRect(rect) {
  const x = Math.min(1, Math.max(0, rect.x));
  const y = Math.min(1, Math.max(0, rect.y));
  return { x, y, w: Math.min(1 - x, Math.max(0, rect.w)), h: Math.min(1 - y, Math.max(0, rect.h)) };
}

function toNormRect({ rect, viewport }) {
  return clampNormRect({
    x: rect.x / viewport.vw, y: rect.y / viewport.vh,
    w: rect.w / viewport.vw, h: rect.h / viewport.vh,
  });
}

function computeIou({ rectA, rectB }) {
  const overlapW = Math.min(rectA.x + rectA.w, rectB.x + rectB.w) - Math.max(rectA.x, rectB.x);
  const overlapH = Math.min(rectA.y + rectA.h, rectB.y + rectB.h) - Math.max(rectA.y, rectB.y);
  if (overlapW <= 0 || overlapH <= 0) return 0;
  const overlap = overlapW * overlapH;
  const union = rectA.w * rectA.h + rectB.w * rectB.h - overlap;
  return union > 0 ? overlap / union : 0;
}

function unionNormRect(rectList) {
  if (!rectList.length) return null;
  const x0 = Math.min(...rectList.map((rect) => rect.x));
  const y0 = Math.min(...rectList.map((rect) => rect.y));
  const x1 = Math.max(...rectList.map((rect) => rect.x + rect.w));
  const y1 = Math.max(...rectList.map((rect) => rect.y + rect.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function readSpokeAgoMs(roi) {
  return typeof roi.spokeAgoMs === 'number' ? roi.spokeAgoMs : Number.POSITIVE_INFINITY;
}

export class RoiStore {
  constructor({
    materialIou = ROI_STORE_DEFAULT_MAP.materialIou,
    settleMs = ROI_STORE_DEFAULT_MAP.settleMs,
    absenceSettleMs = ROI_STORE_DEFAULT_MAP.absenceSettleMs,
    staleMs = ROI_STORE_DEFAULT_MAP.staleMs,
    tieBreakMs = ROI_STORE_DEFAULT_MAP.tieBreakMs,
    now = () => Date.now(),
  } = {}) {
    this.materialIou = materialIou;
    this.settleMs = settleMs;
    this.absenceSettleMs = absenceSettleMs;
    this.staleMs = staleMs;
    this.tieBreakMs = tieBreakMs;
    this.now = now;
    this.reset();
  }

  reset() {
    this.latestRoiList = [];
    this.latestViewport = null;
    this.lastArrivalAt = 0;
    this.isStaleHandled = false;
    this.publishedScreenRect = null;
    this.pendingScreenRect = null;
    this.pendingSinceAt = 0;
    this.screenGeneration = 0;
  }

  submitViewportRoiList(payload) {
    const viewport = payload?.viewport;
    if (!viewport || !(viewport.vw > 0) || !(viewport.vh > 0)) return;
    this.latestViewport = viewport;
    this._acceptRoiList(payload.roiList.map((roi) => ({
      ...roi, rect: toNormRect({ rect: roi.rect, viewport }),
    })));
  }

  _acceptRoiList(normalizedRoiList) {
    const nowMs = this.now();
    this.latestRoiList = normalizedRoiList;
    this.lastArrivalAt = nowMs;
    this.isStaleHandled = false;

    const observed = normalizedRoiList.find((roi) => roi.type === ROI_TYPE_MAP.screenShare)?.rect
      || null;
    this._advanceStabilization({ observed, nowMs });
  }

  _advanceStabilization({ observed, nowMs }) {
    const published = this.publishedScreenRect;

    if (observed && published && computeIou({ rectA: observed, rectB: published }) >= this.materialIou) {
      this.pendingScreenRect = null;
      this.pendingSinceAt = 0;
      return;
    }

    const isSamePending = this.pendingSinceAt > 0 && (
      observed && this.pendingScreenRect
        ? computeIou({ rectA: observed, rectB: this.pendingScreenRect }) >= this.materialIou
        : !observed && !this.pendingScreenRect
    );
    if (!isSamePending) {
      this.pendingScreenRect = observed;
      this.pendingSinceAt = nowMs;
      return;
    }
    this.pendingScreenRect = observed;
    const waitMs = observed ? this.settleMs : this.absenceSettleMs;
    if (nowMs - this.pendingSinceAt < waitMs) return;
    this.pendingSinceAt = 0;
    this.pendingScreenRect = null;
    this._publishScreenRect({ rect: observed });
  }

  _publishScreenRect({ rect }) {
    const published = this.publishedScreenRect;
    const isMaterialChange = Boolean(rect) !== Boolean(published)
      || (rect && published && computeIou({ rectA: rect, rectB: published }) < this.materialIou);
    this.publishedScreenRect = rect;
    if (isMaterialChange) this.screenGeneration += 1;
  }

  _refreshStaleState() {
    if (!this.lastArrivalAt || this.isStaleHandled) return;
    if (this.now() - this.lastArrivalAt <= this.staleMs) return;
    this.isStaleHandled = true;
    this.latestRoiList = [];
    this.latestViewport = null;
    this.pendingScreenRect = null;
    this.pendingSinceAt = 0;
    this._publishScreenRect({ rect: null });
  }

  isFresh() {
    this._refreshStaleState();
    return Boolean(this.lastArrivalAt) && !this.isStaleHandled;
  }

  isScreenAbsencePending() {
    return this.pendingSinceAt > 0 && !this.pendingScreenRect && Boolean(this.publishedScreenRect);
  }

  getScreenRectNorm() {
    this._refreshStaleState();
    if (this.isScreenAbsencePending()) return null;
    return this.publishedScreenRect;
  }

  hasScreenShare() {
    this._refreshStaleState();
    return Boolean(this.getScreenRectNorm());
  }

  getParticipantRectNorm() {
    this._refreshStaleState();
    const rectList = this.latestRoiList
      .filter((roi) => roi.type !== ROI_TYPE_MAP.screenShare && !roi.isSelf)
      .map((roi) => roi.rect);
    return unionNormRect(rectList);
  }

  getScreenGeneration() {
    this._refreshStaleState();
    return this.screenGeneration;
  }

  getViewport() {
    this._refreshStaleState();
    return this.latestViewport;
  }

  getSpeakerVerdict() {
    this._refreshStaleState();
    if (!this.isFresh()) return { kind: SPEAKER_VERDICT_MAP.stale, speaker: null };

    const speakerRoiList = this.latestRoiList.filter((roi) => roi.type === ROI_TYPE_MAP.speaker);
    if (!speakerRoiList.length) return { kind: SPEAKER_VERDICT_MAP.none, speaker: null };
    const otherRoiList = speakerRoiList.filter((roi) => !roi.isSelf);
    if (!otherRoiList.length) return { kind: SPEAKER_VERDICT_MAP.selfOnly, speaker: null };

    const liveRoiList = otherRoiList.filter((roi) => roi.speakingNow);
    const poolList = liveRoiList.length ? liveRoiList : otherRoiList;
    if (poolList.length === 1) return this._buildSpeakerVerdict({ roi: poolList[0] });

    const sortedList = [...poolList].sort((roiA, roiB) => readSpokeAgoMs(roiA) - readSpokeAgoMs(roiB));
    const gapMs = readSpokeAgoMs(sortedList[1]) - readSpokeAgoMs(sortedList[0]);
    if (gapMs > this.tieBreakMs) return this._buildSpeakerVerdict({ roi: sortedList[0] });
    return { kind: SPEAKER_VERDICT_MAP.multiple, speaker: null };
  }

  _buildSpeakerVerdict({ roi }) {
    const { x, y, w, h } = roi.rect;
    return {
      kind: SPEAKER_VERDICT_MAP.unique,
      speaker: {
        participantId: roi.participantId || null,
        name: roi.name || '',
        position: describeDirection({ x: x + w / 2, y: y + h / 2 }),
        rectNorm: roi.rect,
        spokeAgoMs: typeof roi.spokeAgoMs === 'number' ? roi.spokeAgoMs : null,
      },
    };
  }

  getCurrentSpeakerName() {
    const verdict = this.getSpeakerVerdict();
    if (verdict.kind !== SPEAKER_VERDICT_MAP.unique) return null;
    return verdict.speaker.name || null;
  }

  getOverlayPayload({ vw, vh }) {
    this._refreshStaleState();
    if (!this.lastArrivalAt) return null;
    return {
      viewport: { vw, vh },
      roiList: this.latestRoiList.map((roi) => ({
        type: roi.type,
        rect: { x: roi.rect.x * vw, y: roi.rect.y * vh, w: roi.rect.w * vw, h: roi.rect.h * vh },
        lowConfidence: Boolean(roi.lowConfidence),
      })),
    };
  }
}
