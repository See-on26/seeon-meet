import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AsrSegmentTimeline, attachSegmentText, buildAudioGapCandidateList, selectGapCandidateList,
  resolveSilenceSafeInsertMs, GAP_SOURCE_MAP, GAP_BOUNDARY_KIND_MAP, SNAP_REASON_MAP,
  GAP_INSERT_GUARD_MS, GAP_MIN_TAIL_MS,
} from '../src/renderer/core/audio-renderer/audio-gap-candidates.js';

const segment = (startMs, endMs, text) => ({ startMs, endMs, midMs: (startMs + endMs) / 2, text });

test('ASR 세그먼트를 영상 시각으로 바꾸고, 조각 밖으로 넘친 끝 시각은 조각 안으로 자른다', () => {
  const timeline = new AsrSegmentTimeline();
  // 2.5초 조각인데 whisper 가 말 끝을 3.0초로 준 경우.
  timeline.add({
    segmentList: [{ startSec: 0.2, endSec: 1.4, text: '매출이 올랐습니다' }, { startSec: 1.9, endSec: 3.0, text: '다음은' }],
    chunkStartTs: 100000, chunkEndTs: 102500, nowWallTs: 103000, nowVideoTimeMs: 50000,
  });
  assert.deepEqual(timeline.getSegmentList().map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), [
    { startMs: 47200, endMs: 48400, text: '매출이 올랐습니다' },
    { startMs: 48900, endMs: 49500, text: '다음은' },
  ]);
  assert.equal(timeline.getCoveredUntilMs(), 49500);
});

test('ASR 타임라인은 글 없는 세그먼트를 버리고 reset 으로 비운다', () => {
  const timeline = new AsrSegmentTimeline();
  timeline.add({
    segmentList: [{ startSec: 0, endSec: 1, text: '  ' }], chunkStartTs: 0, chunkEndTs: 1000, nowWallTs: 1000, nowVideoTimeMs: 1000,
  });
  assert.deepEqual(timeline.getSegmentList(), []);
  assert.equal(timeline.getCoveredUntilMs(), 1000);
  timeline.reset();
  assert.equal(timeline.getCoveredUntilMs(), -Infinity);
});

test('무음 앞뒤 글은 세그먼트 가운데 시각으로 가르고, 끝맺음은 앞 글과 잰 무음으로 정한다', () => {
  const segmentList = [segment(47200, 48400, '매출이 올랐습니다'), segment(48900, 49500, '다음은')];
  // 끝 시각이 부풀어 무음과 겹쳐도(48400 > 48300) 가운데 시각으로 앞 글이 된다.
  const result = attachSegmentText({ span: { startMs: 48300, endMs: 48800 }, segmentList, asrCoveredUntilMs: 49500 });
  assert.deepEqual(result, { kind: GAP_BOUNDARY_KIND_MAP.complete, beforeText: '매출이 올랐습니다', afterText: '다음은' });
});

test('세그먼트 하나가 무음을 앞뒤로 덮으면 문장 안의 쉼(중단)으로 본다', () => {
  const segmentList = [segment(10000, 14000, '그러니까 이 부분이 핵심인데요'), segment(14200, 15000, '보시면')];
  const result = attachSegmentText({ span: { startMs: 11500, endMs: 12000 }, segmentList, asrCoveredUntilMs: 15000 });
  assert.deepEqual(result, { kind: GAP_BOUNDARY_KIND_MAP.pause, beforeText: '그러니까 이 부분이 핵심인데요', afterText: '보시면' });
});

test('아직 받아쓰기 전인 무음은 끝맺음 미상, 글 없음이다', () => {
  const segmentList = [segment(10000, 11000, '좋습니다')];
  const result = attachSegmentText({ span: { startMs: 13000, endMs: 13600 }, segmentList, asrCoveredUntilMs: 11500 });
  assert.deepEqual(result, { kind: GAP_BOUNDARY_KIND_MAP.unknown, beforeText: '', afterText: '' });
});

test('끝맺음을 정할 수 없으면 미상으로 둔다', () => {
  const segmentList = [segment(10000, 11000, '이건'), segment(11500, 12000, '그래프고')];
  const result = attachSegmentText({ span: { startMs: 11050, endMs: 11250 }, segmentList, asrCoveredUntilMs: 12000 });
  assert.equal(result.kind, GAP_BOUNDARY_KIND_MAP.unknown);
});

test('틈 후보는 무음 시작 + 보호 간격에 놓고, 그 뒤 무음이 짧으면 뺀다', () => {
  const spanList = [
    { startMs: 48300, endMs: 48800, isOpen: false },
    { startMs: 52000, endMs: 52250, isOpen: false },
  ];
  const segmentList = [segment(47200, 48400, '매출이 올랐습니다'), segment(48900, 51900, '다음은 비용입니다')];
  const gapList = buildAudioGapCandidateList({
    spanList, segmentList, asrCoveredUntilMs: 52000,
    triggerVideoTimeMs: 48000, fromVideoTimeMs: 48000, toVideoTimeMs: 60000,
  });
  assert.equal(gapList.length, 1);
  assert.deepEqual(gapList[0], {
    videoTimeMs: 48300 + GAP_INSERT_GUARD_MS, offsetMs: 400, kind: GAP_BOUNDARY_KIND_MAP.complete,
    silenceMs: 600, isOpen: false, source: GAP_SOURCE_MAP.audio,
    beforeText: '매출이 올랐습니다', afterText: '다음은 비용입니다',
  });
  assert.ok(52250 - (52000 + GAP_INSERT_GUARD_MS) < GAP_MIN_TAIL_MS);
});

test('탐색 하한이 긴 무음 한가운데면 하한 바로 뒤에 넣는다', () => {
  const gapList = buildAudioGapCandidateList({
    spanList: [{ startMs: 1000, endMs: 4000, isOpen: false }], segmentList: [], asrCoveredUntilMs: 5000,
    triggerVideoTimeMs: 2000, fromVideoTimeMs: 2500, toVideoTimeMs: 9000,
  });
  assert.equal(gapList[0].videoTimeMs, 2501);
});

test('탐색 범위 밖 무음과 라이브 이후 자리는 후보가 아니다', () => {
  const gapList = buildAudioGapCandidateList({
    spanList: [{ startMs: 1000, endMs: 1800, isOpen: false }, { startMs: 9000, endMs: 9900, isOpen: true }],
    segmentList: [], asrCoveredUntilMs: 9000,
    triggerVideoTimeMs: 3000, fromVideoTimeMs: 3000, toVideoTimeMs: 9050,
  });
  assert.deepEqual(gapList, []);
});

test('진행 중인 무음은 isOpen 으로 알리고 지금까지 길이를 무음으로 적는다', () => {
  const [gap] = buildAudioGapCandidateList({
    spanList: [{ startMs: 5000, endMs: 5900, isOpen: true }], segmentList: [], asrCoveredUntilMs: 4000,
    triggerVideoTimeMs: 4000, fromVideoTimeMs: 4000, toVideoTimeMs: 6000,
  });
  assert.equal(gap.isOpen, true);
  assert.equal(gap.silenceMs, 1000);
  assert.equal(gap.kind, GAP_BOUNDARY_KIND_MAP.unknown);
});

test('트리거와 가까운 10개만, 시각 순서로 남긴다', () => {
  const spanList = Array.from({ length: 15 }, (_, index) => ({ startMs: index * 1000, endMs: index * 1000 + 500, isOpen: false }));
  const gapList = buildAudioGapCandidateList({
    spanList, segmentList: [], asrCoveredUntilMs: 20000,
    triggerVideoTimeMs: 7000, fromVideoTimeMs: -1, toVideoTimeMs: 20000,
  });
  assert.equal(gapList.length, 10);
  assert.deepEqual(gapList.map((gap) => gap.offsetMs), [-4900, -3900, -2900, -1900, -900, 100, 1100, 2100, 3100, 4100]);
});

test('소리 후보가 있으면 측정한 시각의 ASR 후보는 버리고, 측정 못 한 시각의 ASR 후보만 더한다', () => {
  const audioList = [{ videoTimeMs: 3100, offsetMs: 100, kind: 'complete', silenceMs: 500, source: GAP_SOURCE_MAP.audio }];
  const asrList = [
    { videoTimeMs: 2900, offsetMs: -100, kind: 'complete', silenceMs: 300 },
    { videoTimeMs: 7000, offsetMs: 4000, kind: 'pause', silenceMs: 600 },
  ];
  const gapList = selectGapCandidateList({
    audioList, asrList, triggerVideoTimeMs: 3000, isMeasuredAt: (videoTimeMs) => videoTimeMs < 5000,
  });
  assert.deepEqual(gapList.map((gap) => [gap.videoTimeMs, gap.source]), [[3100, 'audio'], [7000, 'asr']]);
});

test('소리 후보가 하나도 없으면(측정 없음·계속 소리 남) 지금 ASR 후보를 그대로 쓴다', () => {
  const asrList = [{ videoTimeMs: 2900, offsetMs: -100, kind: 'complete', silenceMs: 300 }];
  const gapList = selectGapCandidateList({ audioList: [], asrList, triggerVideoTimeMs: 3000, isMeasuredAt: () => true });
  assert.deepEqual(gapList, [{ ...asrList[0], source: GAP_SOURCE_MAP.asr }]);
});

test('넣기 직전: 목표가 무음 안이고 뒤로 충분히 조용하면 그대로 둔다', () => {
  const result = resolveSilenceSafeInsertMs({
    targetMs: 5200, playheadMs: 1000, liveMs: 15000, spanList: [{ startMs: 5000, endMs: 6000, isOpen: false }],
  });
  assert.deepEqual(result, { insertMs: 5200, reason: SNAP_REASON_MAP.inSilence });
});

test('넣기 직전: 말하는 자리면 3초 안의 다음 무음으로 옮긴다', () => {
  const result = resolveSilenceSafeInsertMs({
    targetMs: 5000, playheadMs: 1000, liveMs: 15000,
    spanList: [{ startMs: 3000, endMs: 4000, isOpen: false }, { startMs: 6500, endMs: 7400, isOpen: false }],
  });
  assert.deepEqual(result, { insertMs: 6500 + GAP_INSERT_GUARD_MS, reason: SNAP_REASON_MAP.snapped });
});

test('넣기 직전: 재생이 이미 지나간 목표는 재생 헤드 + 0.3초 이후 첫 무음으로 옮긴다', () => {
  const result = resolveSilenceSafeInsertMs({
    targetMs: 3000, playheadMs: 4000, liveMs: 15000,
    spanList: [{ startMs: 3500, endMs: 4200, isOpen: false }, { startMs: 5000, endMs: 5800, isOpen: false }],
  });
  assert.deepEqual(result, { insertMs: 5000 + GAP_INSERT_GUARD_MS, reason: SNAP_REASON_MAP.snapped });
});

test('넣기 직전: 3초 안에 무음이 없거나 라이브 이후뿐이면 옮기지 않는다', () => {
  const farResult = resolveSilenceSafeInsertMs({
    targetMs: 5000, playheadMs: 1000, liveMs: 15000, spanList: [{ startMs: 8200, endMs: 9000, isOpen: false }],
  });
  assert.deepEqual(farResult, { insertMs: 5000, reason: SNAP_REASON_MAP.noSilence });
  const liveResult = resolveSilenceSafeInsertMs({
    targetMs: 5000, playheadMs: 1000, liveMs: 6000, spanList: [{ startMs: 6000, endMs: 6900, isOpen: true }],
  });
  assert.deepEqual(liveResult, { insertMs: 5000, reason: SNAP_REASON_MAP.noSilence });
});
