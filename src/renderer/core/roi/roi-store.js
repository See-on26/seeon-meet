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
  layoutWaitMs: 3000,
};

// 공유 화면 좌표가 바뀐 까닭. layout 은 Meet 화면 크기가 바뀌어 같은 내용이 자리만 옮긴 것이고,
// screen 은 그 밖의 변화(공유 시작·끝, 같은 크기에서 위치가 바뀜)다.
export const ROI_CHANGE_CAUSE_MAP = { screen: 'screen', layout: 'layout' };

// 좌표가 바뀐 까닭에 따라 슬라이드 감지에서 무엇을 다시 시작할지 정한다. 감지기 기준은 늘 다시 잡지만,
// 크기만 바뀐 경우는 같은 화면이 자리만 옮긴 것이라 체류 판정 중인 전환 고지를 취소하지 않는다.
export function resolveRoiChangeReset({ cause }) {
  return { shouldResetDwell: cause !== ROI_CHANGE_CAUSE_MAP.layout };
}

function toViewportKey({ vw, vh }) {
  return `${Math.round(vw)}x${Math.round(vh)}`;
}

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

export const SELF_MIC_STATE_MAP = { on: 'on', muted: 'muted', unknown: 'unknown' };

// roi-scanner 는 음소거를 micMuted 로 보낸다. 값을 모르면 마이크를 건드리지 않도록 unknown 으로 둔다.
export function resolveSelfMicState(roiList) {
  const self = Array.isArray(roiList) ? roiList.find((roi) => roi?.isSelf) : null;
  if (!self || typeof self.micMuted !== 'boolean') return SELF_MIC_STATE_MAP.unknown;
  return self.micMuted ? SELF_MIC_STATE_MAP.muted : SELF_MIC_STATE_MAP.on;
}

export class RoiStore {
  constructor({
    materialIou = ROI_STORE_DEFAULT_MAP.materialIou,
    settleMs = ROI_STORE_DEFAULT_MAP.settleMs,
    absenceSettleMs = ROI_STORE_DEFAULT_MAP.absenceSettleMs,
    staleMs = ROI_STORE_DEFAULT_MAP.staleMs,
    tieBreakMs = ROI_STORE_DEFAULT_MAP.tieBreakMs,
    layoutWaitMs = ROI_STORE_DEFAULT_MAP.layoutWaitMs,
    now = () => Date.now(),
  } = {}) {
    this.materialIou = materialIou;
    this.settleMs = settleMs;
    this.absenceSettleMs = absenceSettleMs;
    this.staleMs = staleMs;
    this.tieBreakMs = tieBreakMs;
    this.layoutWaitMs = layoutWaitMs;
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
    this.latestViewportKey = null;
    this.publishedViewportKey = null;
    this.pendingViewportKey = null;
    this.expectedViewportKey = null;
    this.expectedSinceAt = 0;
    this.lastChangeCause = ROI_CHANGE_CAUSE_MAP.screen;
  }

  // main 이 Meet 화면 크기를 바꾸기 직전에 부른다. 캡처 영상은 수십 ms 안에 새 크기로 오지만 Meet 좌표는 수백 ms 뒤에 오므로,
  // 그 크기에서 잰 좌표가 도착해 자리 잡을 때까지 공유 화면 좌표를 내주지 않는다.
  expectViewport({ vw, vh }) {
    if (!(vw > 0) || !(vh > 0)) return;
    const viewportKey = toViewportKey({ vw, vh });
    // 이미 그 크기의 좌표를 받고 있으면(접었다가 새 좌표가 오기 전에 다시 편 경우) 기다릴 것이 없다.
    if (viewportKey === this.latestViewportKey) {
      this.expectedViewportKey = null;
      return;
    }
    this.expectedViewportKey = viewportKey;
    this.expectedSinceAt = this.now();
  }

  // 공유 화면 좌표가 지금 Meet 화면 크기에서 잰 것이 아니면 true 다. 이때 자르면 엉뚱한 곳이 잘려 가짜 새 슬라이드가 생긴다.
  // 알린 크기의 좌표가 끝내 오지 않으면(쪽 확대 등) layoutWaitMs 뒤에는 받은 좌표로 돌아간다.
  isLayoutSettling() {
    if (this.expectedViewportKey && this.now() - this.expectedSinceAt <= this.layoutWaitMs) return true;
    return Boolean(this.publishedScreenRect) && this.latestViewportKey !== this.publishedViewportKey;
  }

  getLastChangeCause() {
    return this.lastChangeCause;
  }

  submitViewportRoiList(payload) {
    const viewport = payload?.viewport;
    if (!viewport || !(viewport.vw > 0) || !(viewport.vh > 0)) return;
    this.latestViewport = viewport;
    this.latestViewportKey = toViewportKey(viewport);
    if (this.latestViewportKey === this.expectedViewportKey) this.expectedViewportKey = null;
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
    this._advanceStabilization({ observed, nowMs, viewportKey: this.latestViewportKey });
  }

  // 자리 잡기는 같은 Meet 화면 크기에서 잰 좌표끼리만 잇는다. 크기가 바뀌면 정규화 좌표가 같아도 처음부터 다시 기다린다.
  _advanceStabilization({ observed, nowMs, viewportKey }) {
    const published = this.publishedScreenRect;
    const isPublishedViewport = viewportKey === this.publishedViewportKey;

    if (observed && published && isPublishedViewport
      && computeIou({ rectA: observed, rectB: published }) >= this.materialIou) {
      this.pendingScreenRect = null;
      this.pendingSinceAt = 0;
      return;
    }

    const isSamePending = this.pendingSinceAt > 0 && this.pendingViewportKey === viewportKey && (
      observed && this.pendingScreenRect
        ? computeIou({ rectA: observed, rectB: this.pendingScreenRect }) >= this.materialIou
        : !observed && !this.pendingScreenRect
    );
    if (!isSamePending) {
      this.pendingScreenRect = observed;
      this.pendingSinceAt = nowMs;
      this.pendingViewportKey = viewportKey;
      return;
    }
    this.pendingScreenRect = observed;
    const waitMs = observed ? this.settleMs : this.absenceSettleMs;
    if (nowMs - this.pendingSinceAt < waitMs) return;
    this.pendingSinceAt = 0;
    this.pendingScreenRect = null;
    this._publishScreenRect({ rect: observed, viewportKey });
  }

  _publishScreenRect({ rect, viewportKey = this.publishedViewportKey }) {
    const published = this.publishedScreenRect;
    const isMaterialChange = Boolean(rect) !== Boolean(published)
      || (rect && published && computeIou({ rectA: rect, rectB: published }) < this.materialIou);
    // 정규화 좌표가 거의 같아도 크기가 바뀌었으면 같은 화면을 다른 배율로 다시 뜬 것이라, 감지기 기준을 다시 잡도록 세대를 올린다.
    const isLayoutChange = Boolean(rect) && Boolean(published) && viewportKey !== this.publishedViewportKey;
    this.publishedScreenRect = rect;
    this.publishedViewportKey = viewportKey;
    if (!isMaterialChange && !isLayoutChange) return;
    this.screenGeneration += 1;
    this.lastChangeCause = isLayoutChange ? ROI_CHANGE_CAUSE_MAP.layout : ROI_CHANGE_CAUSE_MAP.screen;
  }

  _refreshStaleState() {
    if (!this.lastArrivalAt || this.isStaleHandled) return;
    if (this.now() - this.lastArrivalAt <= this.staleMs) return;
    this.isStaleHandled = true;
    this.latestRoiList = [];
    this.latestViewport = null;
    this.latestViewportKey = null;
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
    if (this.isLayoutSettling()) return null;
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

  getSelfMicState() {
    return resolveSelfMicState(this.latestRoiList);
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
