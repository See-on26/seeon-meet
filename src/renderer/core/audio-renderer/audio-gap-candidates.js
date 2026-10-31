import { resolveBoundaryKind, BOUNDARY_KIND_MAP } from '../trigger/utterance-boundary-detector.js';
import { wallToVideoTimeMs, clampToChunk } from '../capture/video-time.js';
import { LEVEL_TICK_MS } from './silence-span-tracker.js';

// 틈 후보의 위치는 잰 무음(SilenceSpanTracker)에서만 고르고, ASR 은 그 무음 앞뒤 문장(완결·중단 판단용 글)만 붙인다.
// ASR 끝 시각은 0.1~1초씩 틀려 그 시각에 넣으면 문장 한가운데서 회의가 멈추기 때문이다.
// 소리로 말소리가 확인된 자리의 ASR 후보는 쓰지 않고, 소리를 재지 못한 시각에서만 ASR 후보를 그대로 쓴다.
export const GAP_CANDIDATE_SOURCE_MAP = Object.freeze({
  audio: 'audio',
  asr: 'asr',
});

// 아직 받아쓰기 전인 무음은 문장이 끝났는지 모르므로 미상으로 둔다.
export const GAP_BOUNDARY_KIND_MAP = Object.freeze({
  ...BOUNDARY_KIND_MAP,
  unknown: 'unknown',
});

export const SNAP_REASON_MAP = Object.freeze({
  inSilence: 'in_silence',
  snapped: 'snapped',
  noSilence: 'no_silence',
});

// 무음 시작은 100ms 틱 사이 어딘가라 그만큼 뒤에 넣는다.
export const GAP_INSERT_GUARD_MS = 100;
// 넣는 자리 뒤로 이만큼은 조용해야 한다. 품질·균형 모드에서 스케줄러는 50ms 마다 확인하고
// 따라잡기 배속이 최대 1.5배라 실제 정지가 75ms 남짓 늦을 수 있어, 여유를 더해 0.2초로 둔다.
export const GAP_MIN_TAIL_MS = 200;
// 이미 지난 목표는 재생 헤드보다 이만큼 뒤부터 찾는다. 아직 앞에 있는 목표는 그 자리부터 본다
// (스케줄러가 늦게 멈추는 폭은 넣는 자리 뒤 무음 GAP_MIN_TAIL_MS 가 흡수한다).
const SNAP_LEAD_MS = 300;
const SNAP_MAX_SHIFT_MS = 3000;
// 세그먼트가 무음 시작 앞으로 이만큼, 무음 끝 뒤로 COVER_END_MARGIN_MS 넘게 걸쳐 있고
// 무음 끝 근처에서 시작하는 다른 세그먼트가 없으면 그 무음은 문장 안의 쉼이다.
// 끝 쪽 여유를 더 크게 두는 것은 whisper 가 문장 끝 시각을 부풀리는 경우가 있어서다.
const COVER_START_MARGIN_MS = 300;
const COVER_END_MARGIN_MS = 600;
// 이보다 먼 세그먼트는 무음의 앞뒤 문장으로 보지 않는다.
const NEIGHBOR_TEXT_MAX_GAP_MS = 5000;
const DEFAULT_LIMIT = 10;
const DEFAULT_SEGMENT_RETAIN_MS = 90000;

function pickNearestList({ candidateList, triggerVideoTimeMs, limit }) {
  return [...candidateList]
    .sort((left, right) => Math.abs(left.videoTimeMs - triggerVideoTimeMs) - Math.abs(right.videoTimeMs - triggerVideoTimeMs))
    .slice(0, limit)
    .sort((left, right) => left.videoTimeMs - right.videoTimeMs);
}

// 소리 후보·넣기 직전 맞추기는 지연 버퍼가 라이브보다 충분히 뒤에 있어 앞의 무음을 미리 아는 모드(품질·균형)에서만 쓴다.
// 성능 모드는 지연이 0이라 미리 아는 무음이 없다(대신 회의를 멈추기 직전에 무음을 잠깐 기다린다 — insert-gap-wait.js). 모드를 바꿔도 버퍼는 그대로일 수 있어
// delayMs 는 지금 돌고 있는 지연 버퍼의 목표 지연을 받는다.
export function isAudioGapActive({ gapSource, hasDelayBuffer, delayMs }) {
  return gapSource === GAP_CANDIDATE_SOURCE_MAP.audio && hasDelayBuffer && delayMs > 0;
}

// 해설 하나의 틈 후보 목록. 꺼져 있으면 ASR 후보를 그대로, 켜져 있으면 소리 후보(+측정 못 한 시각의 ASR 후보)를 준다.
export function buildInsertionGapList({ isActive, asrList, spanList, segmentList, isTranscribedAt, isMeasuredAt,
  triggerVideoTimeMs, fromVideoTimeMs, toVideoTimeMs }) {
  if (!isActive) return asrList;
  const audioList = buildAudioGapCandidateList({
    spanList, segmentList, isTranscribedAt, triggerVideoTimeMs, fromVideoTimeMs, toVideoTimeMs,
  });
  return selectGapCandidateList({ audioList, asrList, triggerVideoTimeMs, isMeasuredAt });
}

// 예약할 자리. 꺼져 있으면 목표 그대로(reason 없음), 켜져 있으면 넣기 직전 조용한 자리로 맞춘다.
export function resolveInsertionTargetMs({ isActive, targetMs, playheadMs, liveMs, spanList }) {
  if (!isActive) return { insertMs: targetMs, reason: null };
  return resolveSilenceSafeInsertMs({ targetMs, playheadMs, liveMs, spanList });
}

// ASR 세그먼트를 경계만이 아니라 전부 영상 시각으로 바꿔 두고, 받아쓴 조각 범위도 따로 적는다.
// ASR 응답은 순서가 바뀌거나 빠질 수 있어(글 없음·환각 차단·실패) 끝 시각 하나로는 받아쓴 범위를 알 수 없다.
// 세그먼트 시각은 조각 범위로 자른다(whisper 가 2.5초 조각의 말 끝을 3.0초로 주는 경우가 있다).
export class AsrSegmentTimeline {
  constructor({ retainMs = DEFAULT_SEGMENT_RETAIN_MS } = {}) {
    this.retainMs = retainMs;
    this.reset();
  }

  reset() {
    this.segmentList = [];
    this.transcribedRangeList = [];
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
    const fromMs = toVideoMs(chunkStartTs);
    const toMs = toVideoMs(chunkEndTs);
    if (fromMs !== null && toMs !== null) this.transcribedRangeList.push({ fromMs, toMs });
    const latestMs = Math.max(...this.transcribedRangeList.map((range) => range.toMs), -Infinity);
    const cutoffMs = latestMs - this.retainMs;
    this.segmentList = this.segmentList.filter((entry) => entry.endMs >= cutoffMs);
    this.transcribedRangeList = this.transcribedRangeList.filter((range) => range.toMs >= cutoffMs);
  }

  getSegmentList() {
    return this.segmentList;
  }

  isTranscribedAt(videoTimeMs) {
    return this.transcribedRangeList.some((range) => videoTimeMs >= range.fromMs && videoTimeMs <= range.toMs);
  }
}

function findCoveringIndex({ span, segmentList }) {
  return segmentList.findIndex((entry) => entry.startMs < span.startMs - COVER_START_MARGIN_MS
    && entry.endMs > span.endMs + COVER_END_MARGIN_MS
    && !segmentList.some((other) => other !== entry && other.startMs > span.startMs
      && other.startMs <= span.endMs + COVER_END_MARGIN_MS));
}

// 무음 앞뒤 글은 세그먼트의 가운데 시각으로 가른다. 끝 시각이 부풀거나 일러도 흔들리지 않게 하기 위해서다.
export function attachSegmentText({ span, segmentList, isTranscribedAt }) {
  const coveringIndex = findCoveringIndex({ span, segmentList });
  if (coveringIndex >= 0) {
    return {
      kind: GAP_BOUNDARY_KIND_MAP.pause,
      beforeText: segmentList[coveringIndex].text,
      afterText: segmentList[coveringIndex + 1]?.text || '',
    };
  }
  if (!isTranscribedAt(span.startMs)) {
    return { kind: GAP_BOUNDARY_KIND_MAP.unknown, beforeText: '', afterText: '' };
  }
  const beforeList = segmentList.filter((entry) => entry.midMs < span.startMs
    && entry.endMs >= span.startMs - NEIGHBOR_TEXT_MAX_GAP_MS);
  const before = beforeList[beforeList.length - 1];
  const after = segmentList.find((entry) => entry.midMs > span.endMs
    && entry.startMs <= span.endMs + NEIGHBOR_TEXT_MAX_GAP_MS);
  const kind = resolveBoundaryKind({
    text: before?.text || '', silenceMs: span.endMs - span.startMs + LEVEL_TICK_MS,
  });
  return { kind: kind || GAP_BOUNDARY_KIND_MAP.unknown, beforeText: before?.text || '', afterText: after?.text || '' };
}

// silenceMs 는 넣는 자리 뒤로 남은 무음이다(ASR 후보의 "경계 뒤 무음"과 같은 뜻).
export function buildAudioGapCandidateList({ spanList, segmentList, isTranscribedAt, triggerVideoTimeMs,
  fromVideoTimeMs, toVideoTimeMs, guardMs = GAP_INSERT_GUARD_MS, minTailMs = GAP_MIN_TAIL_MS, limit = DEFAULT_LIMIT }) {
  const candidateList = [];
  for (const span of spanList) {
    const insertMs = Math.max(span.startMs + guardMs, fromVideoTimeMs + 1);
    if (insertMs > toVideoTimeMs || span.endMs - insertMs < minTailMs) continue;
    const { kind, beforeText, afterText } = attachSegmentText({ span, segmentList, isTranscribedAt });
    candidateList.push({
      videoTimeMs: insertMs,
      offsetMs: Math.round(insertMs - triggerVideoTimeMs),
      kind,
      silenceMs: Math.round(span.endMs - insertMs + LEVEL_TICK_MS),
      isOpen: Boolean(span.isOpen),
      source: GAP_CANDIDATE_SOURCE_MAP.audio,
      beforeText,
      afterText,
    });
  }
  return pickNearestList({ candidateList, triggerVideoTimeMs, limit });
}

// 소리 후보가 하나도 없으면(측정이 없었거나 음악·영상처럼 소리가 계속 난 경우) 지금 ASR 후보를 그대로 쓴다.
// 안전한 자리가 없으니 지금보다 나빠지지 않는다.
export function selectGapCandidateList({ audioList, asrList, triggerVideoTimeMs, isMeasuredAt, limit = DEFAULT_LIMIT }) {
  const asrSourcedList = asrList.map((candidate) => ({ ...candidate, source: GAP_CANDIDATE_SOURCE_MAP.asr }));
  if (!audioList.length) return asrSourcedList;
  const unmeasuredAsrList = asrSourcedList.filter((candidate) => !isMeasuredAt(candidate.videoTimeMs));
  return pickNearestList({ candidateList: [...audioList, ...unmeasuredAsrList], triggerVideoTimeMs, limit });
}

// 예약 직전에 넣을 자리가 조용한지 다시 본다. 틈이 없어 트리거 지점에 넣거나, 답이 늦어 재생이 고른 자리를
// 지나쳤을 때 그 자리에서 바로 멈추면 말 한가운데가 끊긴다. 그럴 때 3초 안의 첫 무음(시작 + 보호 간격)으로 옮긴다.
// 옮길 무음이 없으면 원래 목표를 그대로 돌려준다(지금 동작).
export function resolveSilenceSafeInsertMs({ targetMs, playheadMs, liveMs, spanList,
  guardMs = GAP_INSERT_GUARD_MS, minTailMs = GAP_MIN_TAIL_MS, leadMs = SNAP_LEAD_MS, maxShiftMs = SNAP_MAX_SHIFT_MS }) {
  const isReachable = !Number.isFinite(playheadMs) || targetMs >= playheadMs;
  const baseMs = isReachable ? targetMs : playheadMs + leadMs;
  const candidateList = spanList
    .map((span) => ({ span, insertMs: Math.max(span.startMs + guardMs, baseMs) }))
    .filter(({ span, insertMs }) => span.endMs - insertMs >= minTailMs
      && insertMs <= baseMs + maxShiftMs && insertMs <= liveMs)
    .sort((left, right) => left.insertMs - right.insertMs);
  if (!candidateList.length) return { insertMs: targetMs, reason: SNAP_REASON_MAP.noSilence };
  const [{ span, insertMs }] = candidateList;
  return { insertMs, reason: span.startMs <= baseMs ? SNAP_REASON_MAP.inSilence : SNAP_REASON_MAP.snapped };
}
