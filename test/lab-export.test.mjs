import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MODE_POLICY_MAP, MODE_MAP } from '../src/renderer/core/mode/mode-policy.js';
import { NARRATION_QUEUE_TTL_MS } from '../src/renderer/core/audio-renderer/narration-queue.js';

const require = createRequire(import.meta.url);
const { buildTimeMap, wallToMediaMs, resolveCaptureStartWallMs, resolvePlayedWallMs } = require('../src/main/lab/time-map.js');
const labMode = require('../src/main/lab/lab-mode.js');
const { formatMediaClock, formatSrtTime } = require('../src/main/lab/export/clock-format.js');
const { buildTranscriptUtteranceList, buildTranscriptText, toAsrEventListFromRecordList } = require('../src/main/lab/export/transcript.js');
const { buildAdTimeline, summarizeAdTiming, computeOverlapSpeechMs, parseAnchorText } = require('../src/main/lab/export/ad-timeline.js');
const { buildMergedTimelineText, OVERLAP_MASK_TEXT } = require('../src/main/lab/export/s-condition.js');
const { buildAdSrt } = require('../src/main/lab/export/srt.js');
const { buildSlideList } = require('../src/main/lab/export/slides.js');
const { buildRunDirName, sanitizeVideoName } = require('../src/main/lab/export/run-dir-name.js');

test('실험 main 의 모드 값은 렌더러 모드 정책·대기 줄 TTL 과 같다', () => {
  assert.deepEqual(labMode.LAB_MODE_MAP, MODE_MAP);
  for (const mode of labMode.LAB_MODE_LIST) {
    assert.equal(labMode.MODE_DELAY_MS_MAP[mode], MODE_POLICY_MAP[mode].delayMs, mode);
    assert.equal(labMode.isCrossMode(mode), !MODE_POLICY_MAP[mode].isMixed, mode);
  }
  assert.equal(labMode.NARRATION_QUEUE_TTL_MS, NARRATION_QUEUE_TTL_MS);
});

test('평가 설정을 켜면 균형 모드로 시작하고 고른 모드가 있으면 그것을 쓴다', () => {
  assert.equal(labMode.resolveRunMode({ isEvalPreset: true }), 'delayed');
  assert.equal(labMode.resolveRunMode({ isEvalPreset: false }), 'realtime_mix');
  assert.equal(labMode.resolveRunMode({ isEvalPreset: true, requestedMode: 'listening' }), 'listening');
  assert.equal(labMode.resolveRunMode({ isEvalPreset: true, requestedMode: 'nope' }), 'delayed');
});

const playingReportList = [
  { wallMs: 1000, mediaMs: 0, paused: true, ended: false },
  { wallMs: 2000, mediaMs: 0, paused: false, ended: false },
  { wallMs: 3000, mediaMs: 1000, paused: false, ended: false },
  { wallMs: 4000, mediaMs: 2000, paused: true, ended: false },
  { wallMs: 9000, mediaMs: 2000, paused: false, ended: false },
  { wallMs: 10000, mediaMs: 3000, paused: false, ended: true },
];

test('벽시계 → 원본 시각은 보고 사이를 보간하고 일시정지·끝남 동안은 멈춘 위치를 유지한다', () => {
  const timeMap = buildTimeMap({ reportList: [...playingReportList].reverse() });
  assert.equal(wallToMediaMs({ timeMap, wallMs: 500 }), 0, '재생 전');
  assert.equal(wallToMediaMs({ timeMap, wallMs: 2500 }), 500);
  assert.equal(wallToMediaMs({ timeMap, wallMs: 6000 }), 2000, '일시정지 구간');
  assert.equal(wallToMediaMs({ timeMap, wallMs: 9500 }), 2500);
  assert.equal(wallToMediaMs({ timeMap, wallMs: 20000 }), 3000, '끝난 뒤');
  assert.equal(wallToMediaMs({ timeMap: [], wallMs: 1 }), null);
  const runningMap = buildTimeMap({ reportList: [{ wallMs: 1000, mediaMs: 5000, paused: false, ended: false }] });
  assert.equal(wallToMediaMs({ timeMap: runningMap, wallMs: 1500 }), 5500, '마지막 보고 뒤는 1배속');
  assert.equal(wallToMediaMs({ timeMap: runningMap, wallMs: 900 }), 4900);
});

test('캡처 시작 벽시계는 재생 알림의 (벽시계 − 영상 시각) 중앙값, 없으면 처리기 호출 시각이다', () => {
  assert.equal(resolveCaptureStartWallMs({
    captureRequestedWallMs: 900,
    playbackList: [{ wallMs: 5000, liveVideoTimeMs: 4000 }, { wallMs: 8000, liveVideoTimeMs: 6900 }, { wallMs: 9000, liveVideoTimeMs: 8000 }],
  }), 1000);
  assert.equal(resolveCaptureStartWallMs({ captureRequestedWallMs: 900, playbackList: [] }), 900);
  assert.equal(resolvePlayedWallMs({ wallMs: 20000, playbackVideoTimeMs: 9000, liveVideoTimeMs: 19000 }), 10000, '교차 모드는 지연만큼 앞');
  assert.equal(resolvePlayedWallMs({ wallMs: 20000, playbackVideoTimeMs: null, liveVideoTimeMs: 19000 }), 20000);
});

test('시각 표기', () => {
  assert.equal(formatMediaClock(65400), '01:05');
  assert.equal(formatMediaClock(3723000), '62:03');
  assert.equal(formatSrtTime(3723045), '01:02:03,045');
});

const toMediaMs = (wallMs) => (Number.isFinite(wallMs) ? wallMs - 1000 : null);

test('ASR 조각을 세그먼트 단위 발화로 바꾸고 txt 는 [mm:ss] 줄이다', () => {
  const utteranceList = buildTranscriptUtteranceList({
    toMediaMs,
    asrEventList: [
      { ts: 13000, endTs: 15500, text: '둘째', segmentList: [] },
      { ts: 3000, endTs: 6000, text: '하나 둘', segmentList: [{ startSec: 0.5, endSec: 1.5, text: ' 하나 ' }, { startSec: 1.6, endSec: 2.8, text: '둘' }] },
    ],
  });
  assert.deepEqual(utteranceList, [
    { startMs: 2500, endMs: 3500, text: '하나' },
    { startMs: 3600, endMs: 4800, text: '둘' },
    { startMs: 12000, endMs: 14500, text: '둘째' },
  ]);
  assert.equal(buildTranscriptText({ utteranceList }), '[00:02] 하나\n[00:03] 둘\n[00:12] 둘째');
  assert.deepEqual(toAsrEventListFromRecordList([
    { kind: 'asr', ts: 1, text: '말', segmentList: [] },
    { kind: 'asr', ts: 2, text: '환각', skipReason: 'hallucination' },
    { kind: 'narration', ts: 3, text: 'x' },
  ]), [{ ts: 1, endTs: null, text: '말', segmentList: [] }]);
});

const captureStartWallMs = 1000;

function caption(patch) {
  return {
    type: 'caption', ts: 50000, text: '해설', source: 'deixis', narrationClass: 'deixis', slideLabel: '2',
    eventVideoTimeMs: 9000, hasAudio: true, audioDurationMs: 2100, rationale: { utterance: '이 부분이요', summary: '근거 표현=이 부분 · 필기/포인터 영역 있음' },
    ...patch,
  };
}

test('들린 해설은 사건 시각·들린 자리·녹음 위치·지연·겹친 발화를 남기고 못 들은 해설은 사유와 함께 버린 목록에 둔다', () => {
  const utteranceList = [{ startMs: 9500, endMs: 10500, text: '다음 말' }, { startMs: 12000, endMs: 13000, text: '그 뒤' }];
  const { adList, droppedList } = buildAdTimeline({
    captionEventList: [
      caption({}),
      caption({ ts: 60000, text: '음성 없음', hasAudio: false }),
      caption({ ts: 61000, text: '대기 초과' }),
      caption({ ts: 70000, text: '전환', source: 'page-transition', narrationClass: 'page_transition', eventVideoTimeMs: null, rationale: null }),
    ],
    playbackList: [
      { ts: 50000, text: '해설', narrationClass: 'deixis', mode: 'realtime_mix', wallMs: 11000, durationMs: 2000, playbackVideoTimeMs: null, liveVideoTimeMs: 10000 },
      { ts: 70000, text: '전환', narrationClass: 'page_transition', mode: 'realtime_mix', wallMs: 71000, durationMs: 1500, playbackVideoTimeMs: null, liveVideoTimeMs: 70000 },
    ],
    deixisRecordList: [{ kind: 'deixis', ts: 50000, caption: '해설', utterance: '이 부분이요', judgeReason: null }],
    narrationRecordList: [{ kind: 'narration', ts: 40000, text: '중복', source: 'deixis', isEmitted: false, skipReason: 'duplicate:text' }],
    rendererDropList: [{ ts: 61000, text: '대기 초과', reason: 'expired' }],
    utteranceList,
    toMediaMs,
    captureStartWallMs,
    outputStartWallMs: 1500,
  });
  assert.deepEqual(adList.map((ad) => [ad.id, ad.aid, ad.type, ad.text]), [
    ['ad-001', 'A2', 'deixis', '해설'],
    ['ad-002', 'A1', 'page_transition', '전환'],
  ]);
  const [deixis, transition] = adList;
  assert.equal(deixis.eventMediaMs, 9000, '캡처 시작 + 사건 영상 시각');
  assert.equal(deixis.playedMediaMs, 10000);
  assert.equal(deixis.outputMs, 9500);
  assert.equal(deixis.durationMs, 2000);
  assert.equal(deixis.latencyMs, 1000);
  assert.equal(deixis.overlapSpeechMs, 500, '동시 모드: 들린 구간 10000~12000 과 발화 9500~10500 은 500ms 겹치고 12000 에서 맞닿은 발화는 겹치지 않는다');
  assert.deepEqual(deixis.trigger, { utterance: '이 부분이요', anchor: '이 부분', judgeReason: null });
  assert.equal(transition.eventMediaMs, 69000, '사건 영상 시각이 없으면 캡션 ts');
  assert.deepEqual(droppedList.map((drop) => [drop.text, drop.reason]), [
    ['음성 없음', 'no_audio'], ['대기 초과', 'expired'], ['중복', 'duplicate:text'],
  ]);
  assert.deepEqual(summarizeAdTiming({ adList }), {
    adCount: 2, latencyMeanMs: 1000, latencyMedianMs: 1000, overlapSpeechTotalMs: 500, overlapAdCount: 1,
  });
});

test('교차 모드의 자동 해설은 회의를 멈추고 트므로 겹친 발화가 0 이고 질문 답은 겹친다', () => {
  const utteranceList = [{ startMs: 5000, endMs: 9000, text: '말' }];
  const { adList } = buildAdTimeline({
    captionEventList: [caption({ ts: 1, text: '자동', eventVideoTimeMs: 3000 }), caption({ ts: 2, text: '답', narrationClass: 'user_command', eventVideoTimeMs: 3000 })],
    playbackList: [
      { ts: 1, text: '자동', narrationClass: 'deixis', mode: 'delayed', wallMs: 16000, durationMs: 2000, playbackVideoTimeMs: 5000, liveVideoTimeMs: 15000 },
      { ts: 2, text: '답', narrationClass: 'user_command', mode: 'delayed', wallMs: 18000, durationMs: 2000, playbackVideoTimeMs: 7000, liveVideoTimeMs: 17000 },
    ],
    utteranceList, toMediaMs, captureStartWallMs,
  });
  assert.deepEqual(adList.map((ad) => [ad.text, ad.playedMediaMs, ad.overlapSpeechMs, ad.latencyMs]), [
    ['자동', 5000, 0, 2000], ['답', 7000, 2000, 4000],
  ]);
});

test('교차 모드에서 지연 재생 위치가 0 인데 원본이 지연보다 한참 지났으면 모르는 위치로 보고 들린 자리·지연을 비운다', () => {
  // 지연 버퍼가 지연 영상을 붙이기 전에는 getDelayedTimeMs() 가 0 을 돌려준다.
  assert.equal(resolvePlayedWallMs({ wallMs: 61000, mode: 'delayed', playbackVideoTimeMs: 0, liveVideoTimeMs: 60000 }), null);
  assert.equal(resolvePlayedWallMs({ wallMs: 9000, mode: 'delayed', playbackVideoTimeMs: 0, liveVideoTimeMs: 8000 }), 1000, '버퍼가 차는 동안의 0 은 실제 위치');
  const { adList } = buildAdTimeline({
    captionEventList: [caption({ ts: 1, text: '답', narrationClass: 'user_command', eventVideoTimeMs: 50000 })],
    playbackList: [
      { ts: 1, text: '답', narrationClass: 'user_command', mode: 'delayed', wallMs: 61000, durationMs: 2000, playbackVideoTimeMs: 0, liveVideoTimeMs: 60000 },
    ],
    utteranceList: [{ startMs: 0, endMs: 3000, text: '말' }], toMediaMs, captureStartWallMs,
  });
  assert.deepEqual(adList.map((ad) => [ad.text, ad.eventMediaMs, ad.playedMediaMs, ad.latencyMs, ad.heardMediaRange, ad.overlapSpeechMs]), [
    ['답', 50000, null, null, null, 0],
  ]);
  assert.equal(summarizeAdTiming({ adList }).latencyMeanMs, null);
});

test('AD 가 하나도 안 들렸으면 빈 목록과 버린 목록만 남는다', () => {
  const { adList, droppedList } = buildAdTimeline({
    captionEventList: [caption({ hasAudio: false })], playbackList: [], toMediaMs, captureStartWallMs,
  });
  assert.deepEqual(adList, []);
  assert.equal(droppedList[0].reason, 'no_audio');
  assert.deepEqual(summarizeAdTiming({ adList }), {
    adCount: 0, latencyMeanMs: null, latencyMedianMs: null, overlapSpeechTotalMs: 0, overlapAdCount: 0,
  });
});

test('겹친 발화 길이는 구간 교집합의 합이다', () => {
  const utteranceList = [{ startMs: 0, endMs: 1000 }, { startMs: 1500, endMs: 4000 }];
  assert.equal(computeOverlapSpeechMs({ utteranceList, range: { startMs: 500, endMs: 2000 } }), 1000);
  assert.equal(computeOverlapSpeechMs({ utteranceList, range: { startMs: 500, endMs: 500 } }), 0);
  assert.equal(computeOverlapSpeechMs({ utteranceList, range: null }), 0);
  assert.equal(parseAnchorText('근거 표현=(없음)'), '');
});

const mergedUtteranceList = [{ startMs: 1000, endMs: 3000, text: '이 부분이요' }, { startMs: 5000, endMs: 6000, text: '다음입니다' }];
const mergedAdList = [
  { text: '빨간 막대 30%', playedMediaMs: 3000, eventMediaMs: 2500, heardMediaRange: { startMs: 3000, endMs: 5500 } },
  { text: '안 들린 자리 없음', playedMediaMs: null, eventMediaMs: 5000, heardMediaRange: null },
];

test('S 조건 텍스트는 들린 자리에 AD 를 끼우고 같은 시각이면 발화를 먼저 둔다', () => {
  assert.equal(buildMergedTimelineText({ utteranceList: mergedUtteranceList, adList: mergedAdList }), [
    '[00:01] 이 부분이요',
    '[00:03] (화면 해설) 빨간 막대 30%',
    '[00:05] 다음입니다',
    '[00:05] (화면 해설) 안 들린 자리 없음',
  ].join('\n'));
});

test('겹침 마스킹은 기본으로 꺼져 있고 켜면 해설과 겹친 발화 글을 바꾼다', () => {
  const masked = buildMergedTimelineText({ utteranceList: mergedUtteranceList, adList: mergedAdList, isOverlapMasked: true });
  assert.match(masked, new RegExp(`\\[00:05\\] ${OVERLAP_MASK_TEXT.replace(/[[\]]/g, '\\$&')}`));
  assert.match(masked, /\[00:01\] 이 부분이요/);
});

test('AD 자막은 해설 길이만큼 띄우고 다음 자막과 겹치지 않게 자른다', () => {
  const srt = buildAdSrt({
    adList: [
      { text: '둘째', playedMediaMs: 3000, durationMs: 2500 },
      { text: '첫째', playedMediaMs: null, eventMediaMs: 1000, durationMs: 4000 },
    ],
  });
  assert.equal(srt, [
    '1\n00:00:01,000 --> 00:00:02,999\n첫째\n',
    '2\n00:00:03,000 --> 00:00:05,500\n둘째\n',
  ].join('\n'));
});

test('슬라이드 목록은 major 별 첫 base 이미지와 실제 전환 시각이다', () => {
  assert.deepEqual(buildSlideList({
    toMediaMs,
    slideMarkRecordList: [
      { kind: 'slide_mark', ts: 9000, slideLabel: '2', frameKind: 'base', filePath: '/out/slides/s/slide-2/base.jpg', transitionTs: 8000 },
      { kind: 'slide_mark', ts: 2000, slideLabel: '1', frameKind: 'base', filePath: '/out/slides/s/slide-1/base.jpg', transitionTs: null },
      { kind: 'slide_mark', ts: 9500, slideLabel: '2-1', frameKind: 'annotation', filePath: '/a.jpg' },
      { kind: 'slide_mark', ts: 20000, slideLabel: '1', frameKind: 'base', filePath: '/again.jpg' },
    ],
  }), [
    { label: '1', startMediaMs: 1000, file: 'slides/slide-1.jpg', sourcePath: '/out/slides/s/slide-1/base.jpg' },
    { label: '2', startMediaMs: 7000, file: 'slides/slide-2.jpg', sourcePath: '/out/slides/s/slide-2/base.jpg' },
  ]);
});

test('결과 폴더 이름은 시작 시각과 영상 이름이고 공백·금지 문자는 _ 로 바꾼다', () => {
  assert.equal(buildRunDirName({ startedAtMs: new Date(2026, 9, 5, 14, 3, 9).getTime(), videoPath: '/v/발표 녹화: 1차?.mp4' }), '20261005-140309-발표_녹화_1차');
  assert.equal(sanitizeVideoName('/v/???.mp4'), 'video');
  assert.equal(sanitizeVideoName(`/v/${'가'.repeat(80)}.mov`).length, 60);
});
