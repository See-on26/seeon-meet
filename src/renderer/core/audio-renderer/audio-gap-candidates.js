import { resolveBoundaryKind } from '../trigger/utterance-boundary-detector.js';
import { wallToVideoTimeMs } from '../capture/video-time.js';

// 틈 후보의 위치는 잰 무음(SilenceSpanTracker)에서만 고르고, ASR 은 그 무음 앞뒤 문장(완결·중단 판단용 글)만 붙인다.
// ASR 끝 시각은 0.1~1초씩 틀려 그 시각에 넣으면 문장 한가운데서 회의가 멈추기 때문이다.
// 소리로 말소리가 확인된 자리의 ASR 후보는 쓰지 않고, 소리를 재지 못한 시각에서만 ASR 후보를 그대로 쓴다.
export const GAP_SOURCE_MAP = Object.freeze({
  audio: 'audio',
  asr: 'asr',
});

export const GAP_BOUNDARY_KIND_MAP = Object.freeze({
  complete: 'complete',
  pause: 'pause',
  unknown: 'unknown',
});

export const SNAP_REASON_MAP = Object.freeze({
  inSilence: 'in_silence',
  snapped: 'snapped',
  noSilence: 'no_silence',
});

// 무음 시작은 100ms 틱 사이 어딘가라 그만큼 뒤에 넣는다.
export const GAP_INSERT_GUARD_MS = 100;
// 넣는 자리 뒤로 이만큼은 조용해야 한다. 스케줄러가 50ms 마다 확인하고 따라잡기 배속이 최대 1.5배라
// 실제 정지가 75ms 남짓 늦을 수 있어, 여유를 더해 0.2초로 둔다.
export const GAP_MIN_TAIL_MS = 200;
// 잰 무음 길이는 첫·마지막 무음 틱 사이라 실제보다 틱 하나만큼 짧다. 끝맺음 판단에는 그만큼 더해 쓴다.
const LEVEL_TICK_MS = 100;
// 세그먼트가 무음 앞뒤로 이만큼 넘게 걸쳐 있으면 그 무음은 문장 안의 쉼이다.
const COVER_MARGIN_MS = 300;
const SNAP_LEAD_MS = 300;
const SNAP_MAX_SHIFT_MS = 3000;
const DEFAULT_LIMIT = 10;
const DEFAULT_SEGMENT_RETAIN_MS = 90000;

function clampToChunk({ wallTs, chunkStartTs, chunkEndTs }) {
  return Math.min(Math.max(wallTs, chunkStartTs), chunkEndTs);
}

function pickNearestList({ candidateList, triggerVideoTimeMs, limit }) {
  return [...candidateList]
    .sort((left, right) => Math.abs(left.videoTimeMs - triggerVideoTimeMs) - Math.abs(right.videoTimeMs - triggerVideoTimeMs))
    .slice(0, limit)
    .sort((left, right) => left.videoTimeMs - right.videoTimeMs);
}

// ASR 세그먼트를 경계만이 아니라 전부 영상 시각으로 바꿔 둔다. 세그먼트 시각은 조각 범위로 자른다
// (whisper 가 2.5초 조각의 말 끝을 3.0초로 주는 경우가 있다).
export class AsrSegmentTimeline {
  constructor({ retainMs = DEFAULT_SEGMENT_RETAIN_MS } = {}) {
    this.retainMs = retainMs;
    this.reset();
  }

  reset() {
    this.segmentList = [];
    this.coveredUntilMs = -Infinity;
  }

  add({ segmentList = [], chunkStartTs, chunkEndTs, nowWallTs, nowVideoTimeMs }) {
    if (!Number.isFinite(chunkStartTs) || !Number.isFinite(chunkEndTs)) return;
    const toVideoMs = (wallTs) => wallToVideoTimeMs({ wallTs, nowWallTs, nowVideoTimeMs });
    for (const segment of segmentList || []) {
      const text = String(segment?.text || '').trim();
      if (!text || !Number.isFinite(segment.startSec) || !Number.isFinite(segment.endSec)) continue;
      const startMs = toVideoMs(clampToChunk({ wallTs: chunkStartTs + segment.startSec * 1000, chunkStartTs, chunkEndTs }));
      const endMs = toVideoMs(clampToChunk({ wallTs: chunkStartTs + segment.endSec * 1000, chunkStartTs, chunkEndTs }));
      if (startMs === null || endMs === null) continue;
      this.segmentList.push({ startMs, endMs, midMs: (startMs + endMs) / 2, text });
    }
    this.segmentList.sort((left, right) => left.startMs - right.startMs);
    const chunkEndMs = toVideoMs(chunkEndTs);
    if (chunkEndMs !== null) this.coveredUntilMs = Math.max(this.coveredUntilMs, chunkEndMs);
    const cutoffMs = this.coveredUntilMs - this.retainMs;
    this.segmentList = this.segmentList.filter((entry) => entry.endMs >= cutoffMs);
  }

  getSegmentList() {
    return this.segmentList;
  }

  getCoveredUntilMs() {
    return this.coveredUntilMs;
  }
}

// 무음 앞뒤 글은 세그먼트의 가운데 시각으로 가른다. 끝 시각이 부풀거나 일러도 흔들리지 않게 하기 위해서다.
export function attachSegmentText({ span, segmentList, asrCoveredUntilMs, coverMarginMs = COVER_MARGIN_MS }) {
  const coveringIndex = segmentList.findIndex((entry) => entry.startMs < span.startMs - coverMarginMs
    && entry.endMs > span.endMs + coverMarginMs);
  if (coveringIndex >= 0) {
    return {
      kind: GAP_BOUNDARY_KIND_MAP.pause,
      beforeText: segmentList[coveringIndex].text,
      afterText: segmentList[coveringIndex + 1]?.text || '',
    };
  }
  if (!(span.startMs <= asrCoveredUntilMs)) {
    return { kind: GAP_BOUNDARY_KIND_MAP.unknown, beforeText: '', afterText: '' };
  }
  const beforeList = segmentList.filter((entry) => entry.midMs < span.startMs);
  const before = beforeList[beforeList.length - 1];
  const after = segmentList.find((entry) => entry.midMs > span.endMs);
  const kind = resolveBoundaryKind({
    text: before?.text || '', silenceMs: span.endMs - span.startMs + LEVEL_TICK_MS,
  });
  return { kind: kind || GAP_BOUNDARY_KIND_MAP.unknown, beforeText: before?.text || '', afterText: after?.text || '' };
}

export function buildAudioGapCandidateList({ spanList, segmentList, asrCoveredUntilMs, triggerVideoTimeMs,
  fromVideoTimeMs, toVideoTimeMs, guardMs = GAP_INSERT_GUARD_MS, minTailMs = GAP_MIN_TAIL_MS, limit = DEFAULT_LIMIT }) {
  const candidateList = [];
  for (const span of spanList) {
    const insertMs = Math.max(span.startMs + guardMs, fromVideoTimeMs + 1);
    if (insertMs > toVideoTimeMs || span.endMs - insertMs < minTailMs) continue;
    const { kind, beforeText, afterText } = attachSegmentText({ span, segmentList, asrCoveredUntilMs });
    candidateList.push({
      videoTimeMs: insertMs,
      offsetMs: Math.round(insertMs - triggerVideoTimeMs),
      kind,
      silenceMs: Math.round(span.endMs - span.startMs + LEVEL_TICK_MS),
      isOpen: Boolean(span.isOpen),
      source: GAP_SOURCE_MAP.audio,
      beforeText,
      afterText,
    });
  }
  return pickNearestList({ candidateList, triggerVideoTimeMs, limit });
}

// 소리 후보가 하나도 없으면(측정이 없었거나 음악·영상처럼 소리가 계속 난 경우) 지금 ASR 후보를 그대로 쓴다.
// 안전한 자리가 없으니 지금보다 나빠지지 않는다.
export function selectGapCandidateList({ audioList, asrList, triggerVideoTimeMs, isMeasuredAt, limit = DEFAULT_LIMIT }) {
  const asrSourcedList = asrList.map((candidate) => ({ ...candidate, source: GAP_SOURCE_MAP.asr }));
  if (!audioList.length) return asrSourcedList;
  const unmeasuredAsrList = asrSourcedList.filter((candidate) => !isMeasuredAt(candidate.videoTimeMs));
  return pickNearestList({ candidateList: [...audioList, ...unmeasuredAsrList], triggerVideoTimeMs, limit });
}

// 예약 직전에 넣을 자리가 조용한지 다시 본다. 틈이 없어 트리거 지점에 넣거나, 답이 늦어 재생이 고른 자리를
// 지나쳤을 때 그 자리에서 바로 멈추면 말 한가운데가 끊긴다. 그럴 때 3초 안의 다음 무음으로 옮긴다.
export function resolveSilenceSafeInsertMs({ targetMs, playheadMs, liveMs, spanList,
  guardMs = GAP_INSERT_GUARD_MS, minTailMs = GAP_MIN_TAIL_MS, leadMs = SNAP_LEAD_MS, maxShiftMs = SNAP_MAX_SHIFT_MS }) {
  const baseMs = Number.isFinite(playheadMs) ? Math.max(targetMs, playheadMs + leadMs) : targetMs;
  const isInSilence = spanList.some((span) => span.startMs <= baseMs && span.endMs - baseMs >= minTailMs);
  if (isInSilence) return { insertMs: baseMs, reason: SNAP_REASON_MAP.inSilence };
  const nextList = spanList
    .map((span) => ({ span, insertMs: Math.max(span.startMs + guardMs, baseMs) }))
    .filter(({ span, insertMs }) => insertMs <= baseMs + maxShiftMs && insertMs <= liveMs
      && span.endMs - insertMs >= minTailMs)
    .sort((left, right) => left.insertMs - right.insertMs);
  if (nextList.length) return { insertMs: nextList[0].insertMs, reason: SNAP_REASON_MAP.snapped };
  return { insertMs: baseMs, reason: SNAP_REASON_MAP.noSilence };
}
