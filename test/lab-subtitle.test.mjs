import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createSubtitleState, reduceSubtitleState, readKeyAction, shouldFollowBottom,
  SUBTITLE_ACTION_MAP, SUBTITLE_LINE_COUNT_MAP, SUBTITLE_THEME_MAP, MAX_SUBTITLE_LINE_COUNT,
} from '../src/renderer/lab/subtitle/subtitle-state.js';

const require = createRequire(import.meta.url);
const {
  createSubtitleFeed, buildTranscriptLineList, SUBTITLE_KIND_MAP,
} = require('../src/main/lab/subtitle-feed.js');

// 기술 스택 점검표 댓글 #21: 심사위원용 '자막 보기'. 회의 소리는 흰색(또는 검정), AD 는 초록, 배속 재생되는 회의 소리는 파랑.
// 자막은 사용자가 그 소리를 들은 순간에 뜬다(교차 모드는 회의를 늦게 듣는다).
test('받아쓰기 조각은 세그먼트마다 한 줄로, 그 말이 시작한 영상 시각을 붙인다', () => {
  // 지금 벽시계 10,000ms = 영상 50,000ms. 조각은 벽시계 4,000~8,000ms(영상 44,000~48,000ms).
  const lineList = buildTranscriptLineList({
    text: '첫 문장입니다 둘째 문장입니다', chunkStartTs: 4000, chunkEndTs: 8000, nowWallTs: 10_000, nowVideoTimeMs: 50_000,
    segmentList: [{ startSec: 0.5, endSec: 1.8, text: ' 첫 문장입니다' }, { startSec: 2, endSec: 3.5, text: '둘째 문장입니다 ' }, { startSec: 3.6, endSec: 3.9, text: ' ' }],
  });
  assert.deepEqual(lineList, [
    { text: '첫 문장입니다', startVideoTimeMs: 44_500 },
    { text: '둘째 문장입니다', startVideoTimeMs: 46_000 },
  ]);
});

test('세그먼트 시각이 없으면 조각 글 전체를 조각 시작 시각에 한 줄로 둔다', () => {
  assert.deepEqual(buildTranscriptLineList({
    text: ' 통째 문장 ', chunkStartTs: 4000, chunkEndTs: 8000, nowWallTs: 10_000, nowVideoTimeMs: 50_000, segmentList: [],
  }), [{ text: '통째 문장', startVideoTimeMs: 44_000 }]);
  assert.deepEqual(buildTranscriptLineList({ text: '  ', chunkStartTs: 1, chunkEndTs: 2, nowWallTs: 3, nowVideoTimeMs: 3, segmentList: [] }), []);
});

function createFeedProbe() {
  const lineList = [];
  const feed = createSubtitleFeed({ onLine: (line) => lineList.push(line) });
  return { feed, lineList, read: () => lineList.map((line) => [line.kind, line.text]) };
}

test('교차 모드는 지연 재생 위치가 그 말의 시각에 닿을 때 줄을 띄운다', () => {
  const { feed, read } = createFeedProbe();
  feed.updateListen({ isDelayed: true, delayedVideoTimeMs: 30_000, playbackRate: 1 });
  feed.addTranscript({ lineList: [{ text: '앞 말', startVideoTimeMs: 40_000 }, { text: '뒷 말', startVideoTimeMs: 45_000 }] });
  assert.deepEqual(read(), [], '아직 들리지 않았다');
  feed.updateListen({ isDelayed: true, delayedVideoTimeMs: 40_000, playbackRate: 1 });
  assert.deepEqual(read(), [[SUBTITLE_KIND_MAP.meeting, '앞 말']]);
  feed.updateListen({ isDelayed: true, delayedVideoTimeMs: 46_000, playbackRate: 1 });
  assert.deepEqual(read(), [[SUBTITLE_KIND_MAP.meeting, '앞 말'], [SUBTITLE_KIND_MAP.meeting, '뒷 말']]);
});

test('들리는 순간 회의를 1배보다 빠르게 재생 중이면 배속 줄(파랑)로 낸다', () => {
  const { feed, read } = createFeedProbe();
  feed.updateListen({ isDelayed: true, delayedVideoTimeMs: 0, playbackRate: 1 });
  feed.addTranscript({ lineList: [{ text: '따라잡는 중', startVideoTimeMs: 1000 }, { text: '보통 속도', startVideoTimeMs: 2000 }] });
  feed.updateListen({ isDelayed: true, delayedVideoTimeMs: 1500, playbackRate: 1.3 });
  feed.updateListen({ isDelayed: true, delayedVideoTimeMs: 2500, playbackRate: 1 });
  assert.deepEqual(read(), [[SUBTITLE_KIND_MAP.meetingFast, '따라잡는 중'], [SUBTITLE_KIND_MAP.meeting, '보통 속도']]);
});

test('동시 모드(지연 재생 없음)는 받아쓰기가 오는 대로 띄운다', () => {
  const { feed, read } = createFeedProbe();
  feed.updateListen({ isDelayed: false, delayedVideoTimeMs: null, playbackRate: 1 });
  feed.addTranscript({ lineList: [{ text: '바로 뜬다', startVideoTimeMs: 99_000 }] });
  assert.deepEqual(read(), [[SUBTITLE_KIND_MAP.meeting, '바로 뜬다']]);
});

test('들은 위치 보고가 오기 전 받아쓰기는 첫 보고 때 판단한다', () => {
  const { feed, read } = createFeedProbe();
  feed.addTranscript({ lineList: [{ text: '먼저 온 말', startVideoTimeMs: 5000 }] });
  assert.deepEqual(read(), []);
  feed.updateListen({ isDelayed: false, delayedVideoTimeMs: null, playbackRate: 1 });
  assert.deepEqual(read(), [[SUBTITLE_KIND_MAP.meeting, '먼저 온 말']]);
});

test('AD 는 들리기 시작할 때 바로 초록 줄로 내고, 줄마다 다른 id 를 붙인다', () => {
  const { feed, lineList, read } = createFeedProbe();
  feed.updateListen({ isDelayed: true, delayedVideoTimeMs: 0, playbackRate: 1 });
  feed.addNarration({ text: ' 슬라이드 1: 연봉 표 ' });
  feed.addNarration({ text: '' });
  assert.deepEqual(read(), [[SUBTITLE_KIND_MAP.narration, '슬라이드 1: 연봉 표']]);
  feed.updateListen({ isDelayed: false, delayedVideoTimeMs: null, playbackRate: 1 });
  feed.addTranscript({ lineList: [{ text: '말', startVideoTimeMs: 0 }] });
  assert.equal(new Set(lineList.map((line) => line.id)).size, lineList.length);
});

test('새 실행을 시작하면 아직 안 들린 줄을 버린다', () => {
  const { feed, read } = createFeedProbe();
  feed.updateListen({ isDelayed: true, delayedVideoTimeMs: 0, playbackRate: 1 });
  feed.addTranscript({ lineList: [{ text: '지난 실행 말', startVideoTimeMs: 9000 }] });
  feed.reset();
  feed.updateListen({ isDelayed: true, delayedVideoTimeMs: 10_000, playbackRate: 1 });
  assert.deepEqual(read(), []);
});

test('자막 창은 처음에 7줄이 보이고, +/− 로 줄 수를 바꾸고, B 로 바탕을 바꾸고, C 로 지운다', () => {
  assert.equal(SUBTITLE_LINE_COUNT_MAP.initial, 7);
  let state = createSubtitleState();
  assert.equal(state.visibleLineCount, 7);
  assert.equal(state.theme, SUBTITLE_THEME_MAP.dark);
  state = reduceSubtitleState(state, { type: readKeyAction({ code: 'Equal' }) });
  assert.equal(state.visibleLineCount, 6, '+ 는 글자를 키워 보이는 줄이 준다');
  state = reduceSubtitleState(state, { type: readKeyAction({ code: 'Minus' }) });
  state = reduceSubtitleState(state, { type: readKeyAction({ code: 'NumpadSubtract' }) });
  assert.equal(state.visibleLineCount, 8);
  for (let index = 0; index < 30; index += 1) state = reduceSubtitleState(state, { type: SUBTITLE_ACTION_MAP.moreLines });
  assert.equal(state.visibleLineCount, SUBTITLE_LINE_COUNT_MAP.max);
  state = reduceSubtitleState(state, { type: readKeyAction({ code: 'KeyB' }) });
  assert.equal(state.theme, SUBTITLE_THEME_MAP.light);
  state = reduceSubtitleState(state, { type: SUBTITLE_ACTION_MAP.line, line: { id: 'a', kind: 'meeting', text: '말' } });
  state = reduceSubtitleState(state, { type: SUBTITLE_ACTION_MAP.line, line: { id: 'a', kind: 'meeting', text: '말' } });
  assert.equal(state.lineList.length, 1, '같은 줄은 한 번만');
  state = reduceSubtitleState(state, { type: readKeyAction({ code: 'KeyC' }) });
  assert.deepEqual(state.lineList, []);
});

test('지난 자막은 많이 남기되 상한을 넘으면 가장 오래된 줄부터 뺀다', () => {
  let state = createSubtitleState();
  for (let index = 0; index < MAX_SUBTITLE_LINE_COUNT + 5; index += 1) {
    state = reduceSubtitleState(state, { type: SUBTITLE_ACTION_MAP.line, line: { id: String(index), kind: 'meeting', text: `줄${index}` } });
  }
  assert.equal(state.lineList.length, MAX_SUBTITLE_LINE_COUNT);
  assert.equal(state.lineList[0].text, '줄5');
});

test('⌘·Ctrl·Option 을 함께 누른 키는 자막 창 단축키로 읽지 않는다', () => {
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) {
    for (const code of ['KeyC', 'KeyB', 'Equal', 'Minus']) assert.equal(readKeyAction({ code, [modifier]: true }), null, `${modifier}+${code}`);
  }
  assert.equal(readKeyAction({ code: 'KeyX' }), null);
});

test('맨 아래를 보고 있을 때만 새 줄을 따라 내려가고, 위로 올려 보는 중에는 위치를 둔다', () => {
  assert.equal(shouldFollowBottom({ scrollTop: 900, clientHeight: 700, scrollHeight: 1600, lineHeightPx: 100 }), true);
  assert.equal(shouldFollowBottom({ scrollTop: 850, clientHeight: 700, scrollHeight: 1600, lineHeightPx: 100 }), true, '한 줄 안쪽이면 맨 아래로 본다');
  assert.equal(shouldFollowBottom({ scrollTop: 300, clientHeight: 700, scrollHeight: 1600, lineHeightPx: 100 }), false);
});
