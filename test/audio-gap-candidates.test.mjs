import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AsrSegmentTimeline, attachSegmentText, buildAudioGapCandidateList, selectGapCandidateList,
  resolveSilenceSafeInsertMs, isAudioGapActive, buildInsertionGapList, resolveInsertionTargetMs,
  GAP_CANDIDATE_SOURCE_MAP, GAP_BOUNDARY_KIND_MAP, SNAP_REASON_MAP,
} from '../src/renderer/core/audio-renderer/audio-gap-candidates.js';

const segment = (startMs, endMs, text) => ({ startMs, endMs, midMs: (startMs + endMs) / 2, text });
const always = () => true;

// 벽시계와 영상 시각을 같게 둔 타임라인(시험에서 시각을 바로 읽기 위해).
function addChunk(timeline, { startMs, endMs, segmentList }) {
  timeline.add({ segmentList, chunkStartTs: startMs, chunkEndTs: endMs, nowWallTs: endMs, nowVideoTimeMs: endMs });
}

test('ASR 세그먼트를 영상 시각으로 바꾸고, 조각 밖으로 넘친 시각은 조각 안으로 자른다', () => {
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
  assert.equal(timeline.isTranscribedAt(47000), true);
  assert.equal(timeline.isTranscribedAt(49500), true);
  assert.equal(timeline.isTranscribedAt(49600), false);

  const negative = new AsrSegmentTimeline();
  addChunk(negative, { startMs: 1000, endMs: 3000, segmentList: [{ startSec: -0.5, endSec: 0.8, text: '네' }] });
  assert.equal(negative.getSegmentList()[0].startMs, 1000);
});

test('ASR 타임라인은 글 없는 세그먼트를 버리고, 순서가 바뀐 조각도 시각 순으로 두며, reset 으로 비운다', () => {
  const timeline = new AsrSegmentTimeline();
  addChunk(timeline, { startMs: 4000, endMs: 6000, segmentList: [{ startSec: 0, endSec: 1, text: '뒤 조각' }] });
  addChunk(timeline, { startMs: 1000, endMs: 3000, segmentList: [{ startSec: 0, endSec: 1, text: '  ' }, { startSec: 1, endSec: 2, text: '앞 조각' }] });
  assert.deepEqual(timeline.getSegmentList().map((entry) => entry.text), ['앞 조각', '뒤 조각']);
  assert.equal(timeline.isTranscribedAt(3500), false);
  timeline.reset();
  assert.deepEqual(timeline.getSegmentList(), []);
  assert.equal(timeline.isTranscribedAt(1500), false);
});

test('ASR 타임라인은 보관 시간이 지난 세그먼트와 받아쓴 범위를 버린다', () => {
  const timeline = new AsrSegmentTimeline({ retainMs: 10000 });
  addChunk(timeline, { startMs: 0, endMs: 2000, segmentList: [{ startSec: 0, endSec: 1, text: '오래된 말' }] });
  addChunk(timeline, { startMs: 20000, endMs: 22000, segmentList: [{ startSec: 0, endSec: 1, text: '최근 말' }] });
  assert.deepEqual(timeline.getSegmentList().map((entry) => entry.text), ['최근 말']);
  assert.equal(timeline.isTranscribedAt(1000), false);
});

test('무음 앞뒤 글은 세그먼트 가운데 시각으로 가르고, 끝맺음은 앞 글과 잰 무음으로 정한다', () => {
  const segmentList = [segment(47200, 48400, '매출이 올랐습니다'), segment(48900, 49500, '다음은')];
  // 끝 시각이 부풀어 무음과 겹쳐도(48400 > 48300) 가운데 시각으로 앞 글이 된다.
  const result = attachSegmentText({ span: { startMs: 48300, endMs: 48800 }, segmentList, isTranscribedAt: always });
  assert.deepEqual(result, { kind: GAP_BOUNDARY_KIND_MAP.complete, beforeText: '매출이 올랐습니다', afterText: '다음은' });
});

test('세그먼트 하나가 무음을 앞뒤로 넉넉히 덮으면 문장 안의 쉼(중단)으로 본다', () => {
  const segmentList = [segment(10000, 14000, '그러니까 이 부분이 핵심인데요'), segment(14200, 15000, '보시면')];
  const result = attachSegmentText({ span: { startMs: 11500, endMs: 12000 }, segmentList, isTranscribedAt: always });
  assert.deepEqual(result, { kind: GAP_BOUNDARY_KIND_MAP.pause, beforeText: '그러니까 이 부분이 핵심인데요', afterText: '보시면' });
});

test('끝 시각이 부풀어 무음을 덮어 보여도 무음 끝 근처에서 다음 세그먼트가 시작하면 문장 끝으로 본다', () => {
  const segmentList = [segment(0, 4200, '첫 문장입니다.'), segment(3700, 8000, '둘째 문장')];
  const result = attachSegmentText({ span: { startMs: 3000, endMs: 3500 }, segmentList, isTranscribedAt: always });
  assert.deepEqual(result, { kind: GAP_BOUNDARY_KIND_MAP.complete, beforeText: '첫 문장입니다.', afterText: '둘째 문장' });
});

test('아직 받아쓰지 않은 무음(뒤 조각만 먼저 도착한 경우 포함)은 끝맺음 미상, 글 없음이다', () => {
  const timeline = new AsrSegmentTimeline();
  addChunk(timeline, { startMs: 4000, endMs: 6000, segmentList: [{ startSec: 0.2, endSec: 1.5, text: '다음 내용입니다' }] });
  const result = attachSegmentText({
    span: { startMs: 2000, endMs: 2900 }, segmentList: timeline.getSegmentList(),
    isTranscribedAt: (videoTimeMs) => timeline.isTranscribedAt(videoTimeMs),
  });
  assert.deepEqual(result, { kind: GAP_BOUNDARY_KIND_MAP.unknown, beforeText: '', afterText: '' });
});

test('5초보다 먼 세그먼트는 앞 글로 쓰지 않는다', () => {
  const segmentList = [segment(0, 1000, '감사합니다')];
  const result = attachSegmentText({ span: { startMs: 41000, endMs: 41400 }, segmentList, isTranscribedAt: always });
  assert.deepEqual(result, { kind: GAP_BOUNDARY_KIND_MAP.unknown, beforeText: '', afterText: '' });
});

test('끝맺음을 정할 수 없으면 미상으로 둔다', () => {
  const segmentList = [segment(10000, 11000, '이건'), segment(11500, 12000, '그래프고')];
  const result = attachSegmentText({ span: { startMs: 11050, endMs: 11250 }, segmentList, isTranscribedAt: always });
  assert.equal(result.kind, GAP_BOUNDARY_KIND_MAP.unknown);
});

test('틈 후보는 무음 시작 + 보호 간격에 놓고, 무음은 그 자리 뒤로 남은 길이로 적고, 뒤 무음이 짧으면 뺀다', () => {
  const spanList = [
    { startMs: 48300, endMs: 48800, isOpen: false },
    { startMs: 52000, endMs: 52250, isOpen: false },
  ];
  const segmentList = [segment(47200, 48400, '매출이 올랐습니다'), segment(48900, 51900, '다음은 비용입니다')];
  const gapList = buildAudioGapCandidateList({
    spanList, segmentList, isTranscribedAt: always,
    triggerVideoTimeMs: 48000, fromVideoTimeMs: 48000, toVideoTimeMs: 60000,
  });
  assert.deepEqual(gapList, [{
    videoTimeMs: 48400, offsetMs: 400, kind: GAP_BOUNDARY_KIND_MAP.complete,
    silenceMs: 500, isOpen: false, source: GAP_CANDIDATE_SOURCE_MAP.audio,
    beforeText: '매출이 올랐습니다', afterText: '다음은 비용입니다',
  }]);
});

test('탐색 하한이 긴 무음 한가운데면 하한 바로 뒤에 넣는다', () => {
  const [gap] = buildAudioGapCandidateList({
    spanList: [{ startMs: 1000, endMs: 4000, isOpen: false }], segmentList: [], isTranscribedAt: always,
    triggerVideoTimeMs: 2000, fromVideoTimeMs: 2500, toVideoTimeMs: 9000,
  });
  assert.equal(gap.videoTimeMs, 2501);
  assert.equal(gap.silenceMs, 1599);
});

test('탐색 하한 앞에서 끝난 무음과 막 시작해 뒤 무음이 짧은 무음은 후보가 아니다', () => {
  const gapList = buildAudioGapCandidateList({
    spanList: [{ startMs: 1000, endMs: 1800, isOpen: false }, { startMs: 9000, endMs: 9100, isOpen: true }],
    segmentList: [], isTranscribedAt: always,
    triggerVideoTimeMs: 3000, fromVideoTimeMs: 3000, toVideoTimeMs: 9100,
  });
  assert.deepEqual(gapList, []);
});

test('진행 중인 무음은 isOpen 으로 알리고 지금까지 남은 길이를 무음으로 적는다', () => {
  const [gap] = buildAudioGapCandidateList({
    spanList: [{ startMs: 5000, endMs: 5900, isOpen: true }], segmentList: [],
    isTranscribedAt: (videoTimeMs) => videoTimeMs <= 4000,
    triggerVideoTimeMs: 4000, fromVideoTimeMs: 4000, toVideoTimeMs: 5900,
  });
  assert.equal(gap.isOpen, true);
  assert.equal(gap.silenceMs, 900);
  assert.equal(gap.kind, GAP_BOUNDARY_KIND_MAP.unknown);
});

test('트리거와 가까운 10개만, 시각 순서로 남긴다', () => {
  const spanList = Array.from({ length: 15 }, (_, index) => ({ startMs: index * 1000, endMs: index * 1000 + 500, isOpen: false }));
  const gapList = buildAudioGapCandidateList({
    spanList, segmentList: [], isTranscribedAt: always,
    triggerVideoTimeMs: 7000, fromVideoTimeMs: -1, toVideoTimeMs: 20000,
  });
  assert.deepEqual(gapList.map((gap) => gap.offsetMs), [-4900, -3900, -2900, -1900, -900, 100, 1100, 2100, 3100, 4100]);
});

test('소리 후보가 있으면 측정한 시각의 ASR 후보는 버리고, 측정 못 한 시각의 ASR 후보만 더한다', () => {
  const audioList = [{ videoTimeMs: 3100, offsetMs: 100, kind: 'complete', silenceMs: 500, source: GAP_CANDIDATE_SOURCE_MAP.audio }];
  const asrList = [
    { videoTimeMs: 2900, offsetMs: -100, kind: 'complete', silenceMs: 300 },
    { videoTimeMs: 7000, offsetMs: 4000, kind: 'pause', silenceMs: 600 },
  ];
  const gapList = selectGapCandidateList({
    audioList, asrList, triggerVideoTimeMs: 3000, isMeasuredAt: (videoTimeMs) => videoTimeMs < 5000,
  });
  assert.deepEqual(gapList.map((gap) => [gap.videoTimeMs, gap.source]), [[3100, 'audio'], [7000, 'asr']]);
});

test('합친 후보가 10개를 넘으면 트리거와 가까운 10개만 남긴다', () => {
  const audioList = Array.from({ length: 8 }, (_, index) => ({ videoTimeMs: 1000 + index * 100, source: 'audio' }));
  const asrList = Array.from({ length: 5 }, (_, index) => ({ videoTimeMs: 9000 + index * 1000 }));
  const gapList = selectGapCandidateList({ audioList, asrList, triggerVideoTimeMs: 1000, isMeasuredAt: (videoTimeMs) => videoTimeMs < 5000 });
  assert.equal(gapList.length, 10);
  assert.deepEqual(gapList.slice(-2).map((gap) => gap.videoTimeMs), [9000, 10000]);
});

test('소리 후보가 하나도 없으면(측정 없음·계속 소리 남) 지금 ASR 후보를 그대로 쓴다', () => {
  const asrList = [{ videoTimeMs: 2900, offsetMs: -100, kind: 'complete', silenceMs: 300 }];
  const gapList = selectGapCandidateList({ audioList: [], asrList, triggerVideoTimeMs: 3000, isMeasuredAt: always });
  assert.deepEqual(gapList, [{ ...asrList[0], source: GAP_CANDIDATE_SOURCE_MAP.asr }]);
});

test('소리 후보·넣기 직전 맞추기는 audio 이면서 지연 버퍼가 라이브보다 뒤에 있는 모드에서만 쓴다', () => {
  assert.equal(isAudioGapActive({ gapSource: 'audio', hasDelayBuffer: true, delayMs: 10000 }), true);
  assert.equal(isAudioGapActive({ gapSource: 'asr', hasDelayBuffer: true, delayMs: 10000 }), false);
  assert.equal(isAudioGapActive({ gapSource: 'audio', hasDelayBuffer: false, delayMs: 10000 }), false);
  assert.equal(isAudioGapActive({ gapSource: 'audio', hasDelayBuffer: true, delayMs: 0 }), false);
});

test('넣기 직전: 목표가 무음 안이고 뒤로 충분히 조용하면 그대로 둔다', () => {
  const result = resolveSilenceSafeInsertMs({
    targetMs: 5200, playheadMs: 1000, liveMs: 15000, spanList: [{ startMs: 5000, endMs: 6000, isOpen: false }],
  });
  assert.deepEqual(result, { insertMs: 5200, reason: SNAP_REASON_MAP.inSilence });
});

test('넣기 직전: 재생 헤드 바로 앞이라도 닿을 수 있는 목표면 고른 짧은 무음을 그대로 쓴다', () => {
  const spanList = [{ startMs: 5000, endMs: 5450, isOpen: false }, { startMs: 7500, endMs: 8000, isOpen: false }];
  const result = resolveSilenceSafeInsertMs({ targetMs: 5100, playheadMs: 5000, liveMs: 15000, spanList });
  assert.deepEqual(result, { insertMs: 5100, reason: SNAP_REASON_MAP.inSilence });
});

test('넣기 직전: 무음 시작 바로 뒤 목표는 보호 간격만큼 뒤로 맞춘다', () => {
  const result = resolveSilenceSafeInsertMs({
    targetMs: 5010, playheadMs: 1000, liveMs: 15000, spanList: [{ startMs: 5000, endMs: 6000, isOpen: false }],
  });
  assert.deepEqual(result, { insertMs: 5100, reason: SNAP_REASON_MAP.inSilence });
});

test('넣기 직전: 말하는 자리면 3초 안의 다음 무음으로 옮긴다', () => {
  const result = resolveSilenceSafeInsertMs({
    targetMs: 5000, playheadMs: 1000, liveMs: 15000,
    spanList: [{ startMs: 3000, endMs: 4000, isOpen: false }, { startMs: 6500, endMs: 7400, isOpen: false }],
  });
  assert.deepEqual(result, { insertMs: 6600, reason: SNAP_REASON_MAP.snapped });
});

test('넣기 직전: 재생이 이미 지나간 목표는 재생 헤드 + 0.3초 이후의 조용한 자리로 옮긴다', () => {
  const snapped = resolveSilenceSafeInsertMs({
    targetMs: 3000, playheadMs: 4000, liveMs: 15000,
    spanList: [{ startMs: 3500, endMs: 4200, isOpen: false }, { startMs: 5000, endMs: 5800, isOpen: false }],
  });
  assert.deepEqual(snapped, { insertMs: 5100, reason: SNAP_REASON_MAP.snapped });
  const inSilence = resolveSilenceSafeInsertMs({
    targetMs: 3000, playheadMs: 4000, liveMs: 15000, spanList: [{ startMs: 4000, endMs: 5000, isOpen: false }],
  });
  assert.deepEqual(inSilence, { insertMs: 4300, reason: SNAP_REASON_MAP.inSilence });
});

test('넣기 직전: 옮길 무음이 없으면 원래 목표를 그대로 돌려준다', () => {
  const far = resolveSilenceSafeInsertMs({
    targetMs: 5000, playheadMs: 1000, liveMs: 15000, spanList: [{ startMs: 8200, endMs: 9000, isOpen: false }],
  });
  assert.deepEqual(far, { insertMs: 5000, reason: SNAP_REASON_MAP.noSilence });
  const passed = resolveSilenceSafeInsertMs({ targetMs: 3000, playheadMs: 4000, liveMs: 15000, spanList: [] });
  assert.deepEqual(passed, { insertMs: 3000, reason: SNAP_REASON_MAP.noSilence });
});

test('넣기 직전: 재생 헤드를 모르면 목표 자리부터 본다', () => {
  const result = resolveSilenceSafeInsertMs({
    targetMs: 5000, playheadMs: Number.NaN, liveMs: 15000, spanList: [{ startMs: 5000, endMs: 6000, isOpen: false }],
  });
  assert.deepEqual(result, { insertMs: 5100, reason: SNAP_REASON_MAP.inSilence });
});

test('넣기 직전: 재생 헤드보다 조금이라도 앞선 목표는 그 자리의 무음을 쓴다', () => {
  const spanList = [{ startMs: 5000, endMs: 5450, isOpen: false }, { startMs: 7500, endMs: 8000, isOpen: false }];
  const result = resolveSilenceSafeInsertMs({ targetMs: 5150, playheadMs: 5100, liveMs: 15000, spanList });
  assert.deepEqual(result, { insertMs: 5150, reason: SNAP_REASON_MAP.inSilence });
});

test('꺼져 있으면 틈 후보는 ASR 후보 그대로, 예약 자리는 목표 그대로다', () => {
  const asrList = [{ videoTimeMs: 2900, offsetMs: -100, kind: 'complete', silenceMs: 300 }];
  const spanList = [{ startMs: 3000, endMs: 4000, isOpen: false }];
  const common = {
    asrList, spanList, segmentList: [], isTranscribedAt: always, isMeasuredAt: always,
    triggerVideoTimeMs: 3000, fromVideoTimeMs: 2000, toVideoTimeMs: 9000,
  };
  assert.equal(buildInsertionGapList({ ...common, isActive: false }), asrList);
  assert.deepEqual(resolveInsertionTargetMs({ isActive: false, targetMs: 2500, playheadMs: 1000, liveMs: 9000, spanList }),
    { insertMs: 2500, reason: null });
});

test('켜져 있으면 틈 후보는 소리 후보로, 예약 자리는 조용한 자리로 맞춘다', () => {
  const asrList = [{ videoTimeMs: 2900, offsetMs: -100, kind: 'complete', silenceMs: 300 }];
  const spanList = [{ startMs: 3000, endMs: 4000, isOpen: false }];
  const gapList = buildInsertionGapList({
    isActive: true, asrList, spanList, segmentList: [], isTranscribedAt: always, isMeasuredAt: always,
    triggerVideoTimeMs: 3000, fromVideoTimeMs: 2000, toVideoTimeMs: 9000,
  });
  assert.deepEqual(gapList.map((gap) => [gap.videoTimeMs, gap.source]), [[3100, 'audio']]);
  assert.deepEqual(resolveInsertionTargetMs({ isActive: true, targetMs: 2500, playheadMs: 1000, liveMs: 9000, spanList }),
    { insertMs: 3100, reason: SNAP_REASON_MAP.snapped });
});
