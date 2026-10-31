import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  formatClock, truncateText, filterFlowList, buildTimelineItemList, isNearBottom, MAX_RENDERED_ITEM_COUNT,
  createNodeCache, isSameNodeList, planNodeListUpdate, OUTCOME_LABEL_MAP, FLOW_TYPE_OPTION_LIST,
} from '../src/renderer/dev-flow/flow-view.js';

const require = createRequire(import.meta.url);
const {
  buildFlowList, buildFlowView, summarizeTrackList, normalizeNarrationType, STEP_KIND_MAP, OUTCOME_KIND_MAP,
  FLOW_TYPE_LABEL_MAP,
} = require('../src/main/dev-flow/flow-builder.js');

const BASE_MS = 1_000_000;
const at = (offsetMs) => BASE_MS + offsetMs;
const debug = (offsetMs, stage, verdict, reason, detail = '', narrationType = null) => ({
  kind: 'debug', stage, verdict, reason, detail, narrationType, ts: at(offsetMs),
});

const DEIXIS_TEXT = '빨간 막대 표를 보며 설명함';
const TRANSITION_TEXT = '슬라이드 2: 보상구조';
const SILENCE_TEXT = '이미지 제시, 여행 사진';
const RATE_LIMITED_TEXT = '반기 연봉 조정 보는 중';

// 실제 실행(pipeline.jsonl)의 단계 순서를 줄인 것. 렌더러 기록(지시 탐지·예산·틈 없음)은 자기 시각을 쓰므로
// 같은 결정의 main 기록과 ts 가 1ms 어긋나거나(예산) 전혀 다르다(틈 없음).
function buildDebugList() {
  return [
    debug(0, 'session', 'info', '세션 시작', '모드=delayed'),
    debug(1, 'slide', 'info', 'ROI 좌표 변경 → 전환 감지기 리셋', '세대=1'),
    debug(2000, 'asr', 'pass', '전사 도착', '"이 부분이 오늘의 핵심입니다."'),
    debug(3000, 'slide', 'info', '새 슬라이드 확정', '슬라이드 2 거리=0.206 임베딩=gpu → 체류 3000ms 후판정(확정 후 생성)', 'page_transition'),
    debug(4000, 'value_check', 'info', '슬라이드 텍스트 전사 ready', '슬라이드=1 글자수=350'),
    debug(6000, 'slide', 'pass', '체류 확정 (3000ms)', '슬라이드 2 · 지금 고지 생성', 'page_transition'),
    debug(6040, 'screen', 'pass', 'transition_axis:ppt', '화면유형=ppt 주제="보상구조" 사진단독=false', 'page_transition'),
    debug(6040, 'slide', 'info', '주제 판정 fresh', '주제="보상구조" 번호=2(안내순서) 임베딩라벨=2', 'page_transition'),
    debug(6040, 'vlm', 'pass', '전환 내레이션 생성', `"${TRANSITION_TEXT}" (4745ms, 묘사="보상구조")`, 'page_transition'),
    debug(6040, 'toggle', 'skip', '기능 꺼짐 — 캡션 내보내지 않음', `분류=page_transition "${TRANSITION_TEXT}"`, 'page-transition'),
    debug(7000, 'slide', 'skip', '동일 슬라이드 — 전환 아님', '슬라이드 2 거리=0.000 임베딩=gpu', 'page_transition'),
    debug(10000, 'screen_dependency', 'pass', '발화 지시가 트리거', '근거="이 부분" 앞맥락 화면 전환 후 3초', 'deixis'),
    debug(10001, 'budget', 'pass', '지시 후보 발행', '트리거="이 부분" 발화="이 부분이 오늘의 핵심입니다." 영역=프레임 전체 슬라이드=2'),
    debug(11000, 'context', 'info', '슬라이드 1 라벨', '"보상" [보상, 기회] (3411ms)'),
    debug(10000, 'router', 'skip', '후보 없음 (abstract)', '발화="이 부분이 오늘의 핵심입니다." 후보=[없음] 경로=gpu'),
    debug(20000, 'screen_dependency', 'pass', '발화 지시가 트리거', '근거="빨간 막대" 앞맥락 화면 전환 후 10초', 'deixis'),
    debug(20000, 'budget', 'pass', '지시 후보 발행', '트리거="빨간 막대" 발화="빨간 막대들을 보시면" 영역=프레임 전체 슬라이드=2'),
    debug(20000, 'router', 'pass', '확정 deixis/-', '발화="빨간 막대들을 보시면" 후보=[deixis/-] 경로=gpu', 'deixis'),
    debug(20000, 'vlm', 'pass', '생성 deixis/-', `발화="빨간 막대들을 보시면" → "${DEIXIS_TEXT}" (9376ms, 예산 4~10어절)`, 'deixis'),
    debug(20000, 'tts', 'pass', '합성 완료', `370KB · "${DEIXIS_TEXT}"`, 'deixis'),
    debug(30500, 'gap', 'skip', '후보 틈 없음 → 트리거 지점 삽입', `"${DEIXIS_TEXT}" · 재생 23679ms · 트리거 17012ms`, 'deixis'),
    debug(40000, 'tts', 'pass', '합성 완료', `194KB · "${SILENCE_TEXT}"`, 'visual_description'),
    debug(40000, 'silence', 'pass', '무발화 해설 생성', `"${SILENCE_TEXT}" · 직전 발화="여러분, 이 사진들을 한번 보시죠." 무음=5초 슬라이드=4 (5398ms)`, 'visual_description'),
    debug(45000, 'screen_dependency', 'pass', '발화 지시가 트리거', '근거="이 그래프"', 'deixis'),
    debug(45000, 'budget', 'pass', '지시 후보 발행', '트리거="이 그래프" 발화="이 그래프를 보시면" 영역=프레임 전체'),
    debug(45000, 'router', 'pass', '확정 deixis/-', '발화="이 그래프를 보시면" 후보=[deixis/-] 경로=gpu', 'deixis'),
    debug(45000, 'vlm', 'pass', '생성 deixis/-', `발화="이 그래프를 보시면" → "${RATE_LIMITED_TEXT}" (7782ms, 예산 4~10어절)`, 'deixis'),
    debug(45000, 'dedupe', 'skip', '간격 억제', `"${RATE_LIMITED_TEXT}" — 직전 같은 축 캡션과 11초 간격 (최소 18초, 발화만)`, 'deixis'),
    debug(50000, 'silence', 'skip', '분당 1회 상한', '직전 발화="감사합니다." 무음=5초 슬라이드=5 (0ms)', 'visual_description'),
    debug(60000, 'session', 'info', '세션 종료', 'ASR 드레인 0건'),
  ];
}

function buildInput(patch = {}) {
  return {
    debugList: buildDebugList(),
    captionEventList: [
      { type: 'caption', ts: at(20000), text: DEIXIS_TEXT, source: 'deixis', narrationClass: 'deixis' },
      { type: 'caption', ts: at(40000), text: SILENCE_TEXT, source: 'visual_description', narrationClass: 'silence_based' },
    ],
    playbackList: [
      { ts: at(20000), text: DEIXIS_TEXT, wallMs: at(33000), durationMs: 4000, playbackVideoTimeMs: null, liveVideoTimeMs: null },
      { ts: at(40000), text: SILENCE_TEXT, wallMs: at(41000), durationMs: 2000, playbackVideoTimeMs: null, liveVideoTimeMs: null },
    ],
    droppedList: [],
    toMediaMs: (wallMs) => wallMs - BASE_MS,
    ...patch,
  };
}

const findFlow = (flowList, offsetMs) => flowList.find((flow) => flow.ts === at(offsetMs));
// 대표 결과 네 칸(해설별 결과 captionList 는 따로 본다).
const pickOutcome = ({ kind, reason, text, playedMediaMs }) => ({ kind, reason, text, playedMediaMs });
const stageListOf = (flow) => flow.stepList.map((step) => step.stage);

test('결정 하나의 단계를 묶어 시각순 흐름 카드로 만들고 세션 기록·전사·같은 슬라이드 판정은 카드로 만들지 않는다', () => {
  const flowList = buildFlowList(buildInput());
  assert.deepEqual(flowList.map((flow) => [flow.ts - BASE_MS, flow.typeKey, flow.outcome.kind]), [
    [3000, 'page_transition', 'dropped'],
    [10000, 'deixis', 'blocked'],
    [20000, 'deixis', 'played'],
    [40000, 'silence', 'played'],
    [45000, 'deixis', 'dropped'],
    [50000, 'silence', 'blocked'],
  ]);
  assert.equal(new Set(flowList.map((flow) => flow.id)).size, flowList.length);
  const view = buildFlowView(buildInput());
  assert.deepEqual(view.flowList, flowList);
  assert.deepEqual(view.sessionInfoList.map((info) => info.reason), [
    '세션 시작', 'ROI 좌표 변경 → 전환 감지기 리셋', '슬라이드 텍스트 전사 ready', '동일 슬라이드 — 전환 아님', '슬라이드 1 라벨', '세션 종료',
  ]);
  assert.deepEqual(view.asrList, [{ ts: at(2000), mediaMs: 2000, verdict: 'pass', reason: '전사 도착', text: '이 부분이 오늘의 핵심입니다.' }]);
});

test('지시 흐름은 입력 → 트리거 → 통합 라우터 판정 → 지시 대상 에이전트 → 틈 → TTS → 재생됨 순서이고 영상 시각을 붙인다', () => {
  const flow = findFlow(buildFlowList(buildInput()), 20000);
  assert.equal(flow.typeLabel, '지시 대상');
  assert.equal(flow.mediaMs, 20000);
  assert.deepEqual(flow.stepList.map((step) => step.stepKind), [
    STEP_KIND_MAP.input, STEP_KIND_MAP.trigger, STEP_KIND_MAP.trigger, STEP_KIND_MAP.judge, STEP_KIND_MAP.agent,
    STEP_KIND_MAP.post, STEP_KIND_MAP.output, STEP_KIND_MAP.output,
  ]);
  assert.deepEqual(stageListOf(flow), ['input', 'screen_dependency', 'budget', 'router', 'vlm', 'gap', 'tts', 'playback']);
  assert.equal(flow.stepList[0].detail, '빨간 막대들을 보시면');
  assert.equal(flow.stepList[3].label, 'LLM 판단(통합 라우터)');
  const agentStep = flow.stepList[4];
  assert.equal(agentStep.label, '지시 대상 설명 에이전트');
  assert.equal(agentStep.text, DEIXIS_TEXT);
  assert.equal(agentStep.elapsedMs, 9376);
  assert.equal(flow.stepList.at(-1).label, '재생됨');
  assert.deepEqual(pickOutcome(flow.outcome), { kind: OUTCOME_KIND_MAP.played, reason: null, text: DEIXIS_TEXT, playedMediaMs: 33000 });
});

test('페이지 전환은 슬라이드 감지·체류 확정을 앞에 붙이고 기능 꺼짐(옛 표기 page-transition 포함)은 feature_off 로 버려진다', () => {
  const flow = findFlow(buildFlowList(buildInput()), 3000);
  assert.equal(flow.typeLabel, '페이지 전환');
  assert.equal(flow.mediaMs, 3000);
  assert.deepEqual(stageListOf(flow), ['slide', 'slide', 'screen', 'slide', 'vlm', 'toggle', 'drop']);
  assert.deepEqual(flow.stepList.map((step) => step.stepKind), [
    STEP_KIND_MAP.input, STEP_KIND_MAP.trigger, STEP_KIND_MAP.judge, STEP_KIND_MAP.judge, STEP_KIND_MAP.agent,
    STEP_KIND_MAP.post, STEP_KIND_MAP.output,
  ]);
  assert.equal(flow.stepList[4].label, '페이지 전환 설명 에이전트');
  assert.equal(flow.stepList[4].text, TRANSITION_TEXT);
  assert.deepEqual(pickOutcome(flow.outcome), { kind: OUTCOME_KIND_MAP.dropped, reason: 'feature_off', text: TRANSITION_TEXT, playedMediaMs: null });
  // 결과 폴더는 세션 기록의 버린 사유를 그대로 쓴다.
  const finalFlow = findFlow(buildFlowList(buildInput({
    droppedList: [{ ts: at(6040), text: TRANSITION_TEXT, reason: 'feature_off' }], isFinal: true,
  })), 3000);
  assert.equal(finalFlow.outcome.reason, 'feature_off');
});

test('라우터가 후보=[없음] 으로 건너뛰면 해설 없이 막힌 흐름이고 이유는 그 단계의 사유다', () => {
  const flow = findFlow(buildFlowList(buildInput()), 10000);
  assert.deepEqual(stageListOf(flow), ['input', 'screen_dependency', 'budget', 'router']);
  assert.equal(flow.stepList[0].detail, '이 부분이 오늘의 핵심입니다.');
  assert.equal(flow.stepList[3].verdict, 'skip');
  assert.deepEqual(pickOutcome(flow.outcome), { kind: OUTCOME_KIND_MAP.blocked, reason: '후보 없음 (abstract)', text: null, playedMediaMs: null });
});

test('무발화는 무발화 판단과 무발화 에이전트를 거쳐 들리고, 상한에 걸리면 막힌다', () => {
  const flowList = buildFlowList(buildInput());
  const played = findFlow(flowList, 40000);
  assert.equal(played.typeLabel, '무발화 기반');
  assert.deepEqual(stageListOf(played), ['input', 'silence', 'silence', 'tts', 'playback']);
  assert.equal(played.stepList[1].label, 'LLM 판단(무발화)');
  assert.equal(played.stepList[2].label, '무발화 기반 설명 에이전트');
  assert.equal(played.stepList[2].text, SILENCE_TEXT);
  assert.equal(played.outcome.playedMediaMs, 41000);
  const blocked = findFlow(flowList, 50000);
  assert.deepEqual(pickOutcome(blocked.outcome), { kind: OUTCOME_KIND_MAP.blocked, reason: '분당 1회 상한', text: null, playedMediaMs: null });
});

test('간격 억제로 버려진 해설은 rate-limited 이고, 끝난 실행에서 들리지 않은 해설은 not_played 로 버려진다', () => {
  const live = buildFlowList(buildInput());
  assert.deepEqual(pickOutcome(findFlow(live, 45000).outcome), {
    kind: OUTCOME_KIND_MAP.dropped, reason: 'rate-limited', text: RATE_LIMITED_TEXT, playedMediaMs: null,
  });
  const input = buildInput({ playbackList: [] });
  assert.equal(findFlow(buildFlowList(input), 20000).outcome.kind, OUTCOME_KIND_MAP.pending, '실행 중에는 아직 기다린다');
  assert.deepEqual(pickOutcome(findFlow(buildFlowList({ ...input, isFinal: true }), 20000).outcome), {
    kind: OUTCOME_KIND_MAP.dropped, reason: 'not_played', text: DEIXIS_TEXT, playedMediaMs: null,
  });
});

test('라우터 결과가 오기 전 지시 탐지·예산만 있으면 진행 중인 흐름 하나다', () => {
  const flowList = buildFlowList({
    debugList: [
      debug(0, 'screen_dependency', 'pass', '발화 지시가 트리거', '근거="이 그래프"', 'deixis'),
      debug(1, 'budget', 'pass', '지시 후보 발행', '트리거="이 그래프" 발화="이 그래프를 보시면"'),
    ],
    toMediaMs: () => null,
  });
  assert.equal(flowList.length, 1);
  assert.equal(flowList[0].outcome.kind, OUTCOME_KIND_MAP.pending);
  assert.equal(flowList[0].mediaMs, null);
});

test('옛 표기 page-transition 은 page_transition 으로 읽는다', () => {
  assert.equal(normalizeNarrationType('page-transition'), 'page_transition');
  assert.equal(normalizeNarrationType('deixis'), 'deixis');
  assert.equal(normalizeNarrationType(null), null);
  const [flow] = buildFlowList({
    debugList: [debug(0, 'vlm', 'pass', '전환 내레이션 생성', '"슬라이드 3: 표" (2000ms)', 'page-transition')],
    toMediaMs: () => null,
  });
  assert.equal(flow.typeKey, 'page_transition');
  assert.equal(flow.typeLabel, '페이지 전환');
});

test('라우터가 고른 유형으로 발화 기반 흐름 이름을 붙인다', () => {
  const flowList = buildFlowList({
    debugList: [
      debug(0, 'router', 'pass', '확정 visual_description/scale', '발화="척도" 후보=[visual_description/scale]', 'visual_description'),
      debug(5000, 'router', 'pass', '확정 interpretation/value_to_meaning', '발화="250" 후보=[interpretation/value_to_meaning]', 'interpretation'),
      debug(5000, 'vlm', 'pass', '생성 interpretation/value_to_meaning', '발화="250" → "250 상승" (3000ms)', 'interpretation'),
    ],
    toMediaMs: () => null,
  });
  assert.deepEqual(flowList.map((flow) => flow.typeLabel), ['발화 기반(척도)', '발화 기반(수치·변화)']);
  assert.equal(flowList[1].stepList.find((step) => step.stage === 'vlm').label, '발화 기반 설명 에이전트');
});

test('신호등은 최근 3초 안의 마지막 기록으로 상태를 정하고 그보다 오래되면 쉰다', () => {
  const nowWallMs = at(100000);
  const received = (entry, agoMs) => ({ ...entry, receivedWallMs: nowWallMs - agoMs });
  const trackList = summarizeTrackList({
    debugList: [
      received(debug(0, 'asr', 'pass', '전사 도착', '"말"'), 500),
      received(debug(0, 'slide', 'info', '새 슬라이드 확정', '슬라이드 3', 'page_transition'), 1000),
      received(debug(0, 'router', 'pass', '확정 deixis/-', ''), 2500),
      received(debug(0, 'router', 'skip', '후보 없음', ''), 800),
      received(debug(0, 'vlm', 'fail', '캡션 생성 실패', ''), 5000),
    ],
    playbackList: [{ ts: 1, text: '해설', wallMs: nowWallMs - 1000, durationMs: 4000 }],
    nowWallMs,
  });
  assert.deepEqual(trackList.map((track) => [track.key, track.state]), [
    ['asr', 'pass'], ['page_transition', 'active'], ['judge', 'skip'], ['silence', 'idle'], ['vlm', 'idle'], ['output', 'active'],
  ]);
  assert.deepEqual(trackList.map((track) => track.label), ['ASR', '페이지 전환', '지시·발화 판단', '무발화', 'VLM 생성', 'TTS·재생']);
  assert.equal(trackList[2].lastDetail, '후보 없음');
  assert.equal(trackList[4].lastWallMs, nowWallMs - 5000);
  assert.equal(trackList[3].lastWallMs, null);
});

test('흐름 창 표시: 시각 표기·거르기·전사 줄 끼워 넣기·아래 붙임 판단', () => {
  assert.equal(formatClock(65400), '01:05');
  assert.equal(formatClock(null), '--:--');
  assert.equal(truncateText('가나다라마', 4), '가나다…');
  assert.equal(truncateText('가나', 4), '가나');
  const flowList = buildFlowList(buildInput());
  const filtered = filterFlowList({ flowList, hiddenTypeSet: new Set(['page_transition']), hiddenOutcomeSet: new Set(['blocked']) });
  assert.deepEqual(filtered.map((flow) => flow.ts - BASE_MS), [20000, 40000, 45000]);
  const asrList = [{ ts: at(20000), text: '같은 시각 전사' }, { ts: at(1), text: '처음' }];
  assert.deepEqual(buildTimelineItemList({ flowList: filtered, asrList }).map((item) => item.kind), ['flow', 'flow', 'flow']);
  assert.deepEqual(buildTimelineItemList({ flowList: filtered, asrList, isAsrVisible: true }).map((item) => item.kind), ['asr', 'asr', 'flow', 'flow', 'flow']);
  const manyList = Array.from({ length: MAX_RENDERED_ITEM_COUNT + 10 }, (_unused, index) => ({ id: String(index), ts: index, outcome: {} }));
  const itemList = buildTimelineItemList({ flowList: manyList });
  assert.equal(itemList.length, MAX_RENDERED_ITEM_COUNT);
  assert.equal(itemList.at(-1).item.id, String(MAX_RENDERED_ITEM_COUNT + 9));
  assert.equal(isNearBottom({ scrollTop: 980, clientHeight: 500, scrollHeight: 1500 }), true);
  assert.equal(isNearBottom({ scrollTop: 200, clientHeight: 500, scrollHeight: 1500 }), false);
});

// 실제 production 기록 꼴로 만든 고정 입력.

function buildUnlabeledTransitionDebugList() {
  return [
    debug(0, 'slide', 'info', '새 슬라이드 확정', '슬라이드 3 거리=0.150 임베딩=gpu → 체류 3000ms 후판정(확정 후 생성)', 'page_transition'),
    debug(3000, 'slide', 'pass', '체류 확정 (3000ms)', '슬라이드 3 · 지금 고지 생성', 'page_transition'),
    // 같은 주제 재검출: 화면 판정 기록에 슬라이드 번호가 없다.
    debug(3030, 'screen', 'pass', 'first_appearance', '화면유형=doc 주제="평가 구조" 사진단독=false', 'page_transition'),
    debug(3030, 'screen', 'skip', '직전과 같은 화면 — 고지하지 않음', '주제="평가 구조" 주제유사도=0.912 묘사유사도=0.800 최근접="평가 구조"', 'page_transition'),
    debug(10000, 'slide', 'info', '새 슬라이드 확정', '슬라이드 4 거리=0.300 임베딩=gpu → 체류 3000ms 후판정(확정 후 생성)', 'page_transition'),
    debug(13000, 'slide', 'pass', '체류 확정 (3000ms)', '슬라이드 4 · 지금 고지 생성', 'page_transition'),
    // VLM 실패: 실패 기록에도 슬라이드 번호가 없다.
    debug(13020, 'vlm', 'fail', '전환 내레이션 실패', 'vlm: The operation was aborted due to timeout', 'page_transition'),
  ];
}

test('슬라이드 번호가 없는 main 기록(같은 주제 재검출·VLM 실패)도 앞선 감지·체류 확정과 한 흐름으로 묶인다', () => {
  const flowList = buildFlowList({ debugList: buildUnlabeledTransitionDebugList(), toMediaMs: (wallMs) => wallMs - BASE_MS, isFinal: true });
  assert.deepEqual(flowList.map((flow) => [flow.ts - BASE_MS, flow.typeKey, flow.slideLabel, flow.outcome.kind]), [
    [0, 'page_transition', '3', 'blocked'],
    [10000, 'page_transition', '4', 'blocked'],
  ]);
  assert.deepEqual(stageListOf(flowList[0]), ['slide', 'slide', 'screen', 'screen']);
  assert.equal(flowList[0].outcome.reason, '직전과 같은 화면 — 고지하지 않음');
  assert.deepEqual(stageListOf(flowList[1]), ['slide', 'slide', 'vlm']);
  assert.equal(flowList[1].outcome.reason, '전환 내레이션 실패');
});

test('끝난 실행에서 결과 기록이 없는 흐름은 진행 중으로 남지 않고 결과 없음(unknown)이다', () => {
  const debugList = [
    debug(0, 'slide', 'info', '새 슬라이드 확정', '슬라이드 2 거리=0.200 임베딩=gpu', 'page_transition'),
    debug(3000, 'slide', 'pass', '체류 확정 (3000ms)', '슬라이드 2 · 지금 고지 생성', 'page_transition'),
  ];
  assert.equal(buildFlowList({ debugList, toMediaMs: () => null }).at(0).outcome.kind, OUTCOME_KIND_MAP.pending);
  assert.deepEqual(pickOutcome(buildFlowList({ debugList, toMediaMs: () => null, isFinal: true }).at(0).outcome), {
    kind: OUTCOME_KIND_MAP.unknown, reason: '결과 기록 없음', text: null, playedMediaMs: null,
  });
  assert.equal(OUTCOME_LABEL_MAP.unknown, '결과 없음');
});

test('카드 시각은 사건 시각(eventMediaMs)이다: 해설은 ad-timeline 과 같은 캡처 시각 변환, 해설이 없으면 입력 발화의 전사 시각', () => {
  const input = buildInput({
    captureStartWallMs: BASE_MS,
    captionEventList: buildInput().captionEventList.map((caption) => (caption.ts === at(20000) ? { ...caption, eventVideoTimeMs: 15000 } : caption)),
    utteranceList: [
      { startMs: 7500, endMs: 9000, text: '이 부분이 오늘의 핵심입니다.' },
      { startMs: 43000, endMs: 44000, text: '이 그래프를 보시면' },
      { startMs: 9000, endMs: 9500, text: '네' },
    ],
  });
  const flowList = buildFlowList(input);
  assert.deepEqual(flowList.map((flow) => [flow.mediaMs, flow.eventMediaMs]), [
    [3000, 3000],
    [10000, 7500],
    [20000, 15000],
    [40000, 40000],
    [45000, 43000],
    [50000, 50000],
  ]);
});

test('사진 단독 제시의 화면 묘사는 전환 흐름 안에서 페이지 전환 에이전트의 사진 묘사로 보이고 해설마다 결과가 따로 보인다', () => {
  const leaderText = '슬라이드 4: 여행 사진';
  const followerText = '해변에서 웃는 사람들 사진';
  const debugList = [
    debug(0, 'slide', 'info', '새 슬라이드 확정', '슬라이드 4 거리=0.294 임베딩=gpu', 'page_transition'),
    debug(3000, 'slide', 'pass', '체류 확정 (3000ms)', '슬라이드 4 · 지금 고지 생성', 'page_transition'),
    debug(3020, 'screen', 'pass', 'first_appearance', '화면유형=photo 주제="여행" 사진단독=true', 'page_transition'),
    debug(3020, 'slide', 'info', '주제 판정 fresh', '주제="여행" 번호=4(안내순서) 임베딩라벨=4', 'page_transition'),
    debug(3020, 'vlm', 'pass', '전환 내레이션 생성', `"${leaderText}" (3000ms, 묘사="여행 사진")`, 'page_transition'),
    debug(3020, 'tts', 'pass', '합성 완료', `100KB · "${leaderText}"`, 'page-transition'),
    debug(3020, 'vlm', 'pass', '사진 단독 화면 묘사(페이지 전환) 생성', `"${followerText}"`, 'visual_description'),
    debug(3020, 'tts', 'pass', '합성 완료', `120KB · "${followerText}"`, 'visual_description'),
  ];
  const captionEventList = [
    { ts: at(3020), text: leaderText, source: 'page-transition', narrationClass: 'page_transition', slideLabel: '4' },
    { ts: at(3020), text: followerText, source: 'visual_description', narrationClass: 'page_transition', slideLabel: '4' },
  ];
  const playbackList = [
    { ts: at(3020), text: leaderText, wallMs: at(5000), durationMs: 2000 },
    { ts: at(3020), text: followerText, wallMs: at(7500), durationMs: 3000 },
  ];
  const [flow] = buildFlowList({ debugList, captionEventList, playbackList, toMediaMs: (wallMs) => wallMs - BASE_MS, isFinal: true });
  assert.equal(flow.typeKey, 'page_transition');
  assert.deepEqual(flow.stepList.filter((step) => step.stage === 'vlm').map((step) => step.label), ['페이지 전환 설명 에이전트', '페이지 전환 설명 에이전트(사진 묘사)']);
  assert.deepEqual(pickOutcome(flow.outcome), { kind: OUTCOME_KIND_MAP.played, reason: null, text: leaderText, playedMediaMs: 5000 });
  assert.deepEqual(flow.outcome.captionList, [
    { text: leaderText, kind: OUTCOME_KIND_MAP.played, reason: null, playedMediaMs: 5000 },
    { text: followerText, kind: OUTCOME_KIND_MAP.played, reason: null, playedMediaMs: 7500 },
  ]);
  assert.deepEqual(flow.stepList.filter((step) => step.stepKind === STEP_KIND_MAP.output && step.stage !== 'tts').map((step) => step.label), ['재생됨', '재생됨']);
  // 묘사만 재생 대기 줄에서 버려지면 그 줄만 버려짐이다.
  const [partial] = buildFlowList({
    debugList, captionEventList, playbackList: playbackList.slice(0, 1),
    droppedList: [{ ts: at(3020), text: followerText, reason: 'stale' }], toMediaMs: (wallMs) => wallMs - BASE_MS, isFinal: true,
  });
  assert.equal(partial.outcome.kind, OUTCOME_KIND_MAP.played);
  assert.deepEqual(partial.outcome.captionList.map((caption) => [caption.kind, caption.reason]), [['played', null], ['dropped', 'stale']]);
});

test('흐름 유형 이름은 아키텍처 에이전트 묶음 이름이고, 흐름 창 거르기 목록도 같은 이름이다', () => {
  assert.deepEqual(FLOW_TYPE_LABEL_MAP, {
    page_transition: '페이지 전환',
    deixis: '지시 대상',
    interpretation: '발화 기반(수치·변화)',
    visual_description: '발화 기반(척도)',
    silence: '무발화 기반',
    user_command: '질문 답',
    speaker_identity: '화자 식별',
    screen_change: '화면 변화',
    unknown: '기타',
  });
  assert.deepEqual(
    Object.fromEntries(FLOW_TYPE_OPTION_LIST.map(({ key, label }) => [key, label])),
    FLOW_TYPE_LABEL_MAP,
  );
});

test('파이프라인의 사진 단독 화면 묘사 사유는 옛 번호(2-4A) 대신 페이지 전환 소속을 적는다', () => {
  const source = fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /2-4A/);
  assert.doesNotMatch(source, /무발화\(4-1\)/);
  assert.match(source, /reason: '사진 단독 화면 묘사\(페이지 전환\) 생성'/);
});

test('흐름 창은 바뀌지 않은 갱신값이면 같은 노드 목록이라 목록을 다시 넣지 않는다', () => {
  let createCount = 0;
  const cache = createNodeCache({ createNode: (timelineItem) => { createCount += 1; return { key: timelineItem.key }; } });
  const toNodeList = () => buildTimelineItemList({ flowList: buildFlowList(buildInput()) }).map(cache.resolve);
  const firstList = toNodeList();
  const secondList = toNodeList();
  assert.equal(createCount, 6);
  assert.equal(isSameNodeList(firstList, secondList), true);
  const changedInput = buildInput({ playbackList: [] });
  const changedList = buildTimelineItemList({ flowList: buildFlowList(changedInput) }).map(cache.resolve);
  assert.equal(isSameNodeList(secondList, changedList), false);
  assert.equal(createCount, 8, '재생 알림이 빠진 두 흐름만 새로 만든다');
  cache.prune(new Set());
  assert.equal(cache.size(), 0);
  assert.equal(isSameNodeList([], []), true);
  assert.equal(isSameNodeList([{}], []), false);
});

test('목록 갱신은 새 카드만 덧붙이거나 바뀐 카드만 갈아 끼우고, 순서가 바뀌면 통째로 다시 넣는다', () => {
  const [a, b, c, d, b2] = ['a', 'b', 'c', 'd', 'b2'].map((name) => ({ name }));
  assert.deepEqual(planNodeListUpdate([a, b], [a, b]), { kind: 'none' });
  assert.deepEqual(planNodeListUpdate([a, b], [a, b, c, d]), { kind: 'append', appendList: [c, d] });
  assert.deepEqual(planNodeListUpdate([a, b, c], [a, b2, c]), { kind: 'replace', replaceList: [{ index: 1, node: b2 }] });
  assert.deepEqual(planNodeListUpdate([a, b, c], [b, c, d]), { kind: 'reset' }, '앞이 빠지고 밀리면 통째로');
  assert.deepEqual(planNodeListUpdate([a, b, c], [a, c]), { kind: 'reset' });
  assert.deepEqual(planNodeListUpdate([], [a]), { kind: 'append', appendList: [a] });
});

test('트리거 후보 기록은 그 후보를 판단한 결정 흐름에 붙고, 후보마다 O/X 는 판정 단계이며, TTS 실패 버림은 소리 없음이다', () => {
  const text = '빨간 막대 설명';
  const debugList = [
    debug(1000, 'router', 'info', '트리거 후보 2개 (kiwi)', '지시대명사:"이 부분", 단순 수치:"30%" · 전사="이 부분이 30%예요"'),
    debug(1500, 'router', 'info', '트리거 후보 1개 (kiwi)', '지시대명사:"저기" · 전사="저기 보세요"'),
    debug(4000, 'router', 'pass', '판단 LLM 1/2 공백', '지시대명사:"이 부분"=O(대상 없음) · 단순 수치:"30%"=X(앞에서 밝힘)'),
    debug(4000, 'router', 'pass', '확정 deixis/simple', '발화="이 부분이 30%예요" 후보=[deixis/simple] 경로=gpu', 'deixis'),
    debug(4000, 'vlm', 'pass', '생성 deixis/simple', `발화="이 부분이 30%예요" → "${text}" (900ms, 예산 4~10어절)`, 'deixis'),
    debug(4000, 'tts', 'fail', 'TTS 실패(소리 없이 넘어감)', 'HTTP 500', 'deixis'),
  ];
  const view = buildFlowView({
    debugList,
    captionEventList: [{ type: 'caption', ts: at(4000), text, source: 'deixis', narrationClass: 'deixis' }],
    droppedList: [{ ts: at(4000), text, reason: 'tts_failed' }],
    toMediaMs: (wallMs) => wallMs - BASE_MS,
    isFinal: true,
  });
  assert.equal(view.flowList.length, 1, '트리거 후보 기록이 따로 흐름이 되지 않는다');
  const [flow] = view.flowList;
  assert.deepEqual(flow.stepList.filter((step) => step.stage === 'router').map((step) => [step.stepKind, step.label]), [
    [STEP_KIND_MAP.trigger, '트리거 후보(형태소 분석)'],
    [STEP_KIND_MAP.judge, 'LLM 판단(후보마다 O/X)'],
    [STEP_KIND_MAP.judge, 'LLM 판단(통합 라우터)'],
  ]);
  assert.equal(flow.stepList.find((step) => step.stepKind === STEP_KIND_MAP.trigger).summary, '지시대명사:"이 부분", 단순 수치:"30%"');
  assert.deepEqual([flow.outcome.kind, flow.outcome.reason], [OUTCOME_KIND_MAP.dropped, 'no_audio']);
  assert.ok(view.sessionInfoList.some((info) => info.reason === '트리거 후보 1개 (kiwi)'), '결정에 이르지 않은 트리거 후보는 세션 기록이다');
});

const { MODE_DELAY_MS_MAP } = require('../src/main/dev-flow/mode-delay.js');
const { resolveRendererDropReason, DROP_REASON_MAP } = require('../src/main/dev-flow/drop-reason.js');
const { resolvePlayedWallMs, resolveCaptureStartWallMs } = require('../src/main/dev-flow/played-time.js');
const { buildTranscriptUtteranceList } = require('../src/main/dev-flow/transcript-utterance.js');

test('공용 모드 지연값은 렌더러 mode-policy 의 delayMs 와 같다', async () => {
  const { MODE_POLICY_MAP } = await import('../src/renderer/core/mode/mode-policy.js');
  for (const mode of Object.keys(MODE_DELAY_MS_MAP)) assert.equal(MODE_DELAY_MS_MAP[mode], MODE_POLICY_MAP[mode].delayMs, mode);
});

test('렌더러 버림 사유 중 TTS 실패는 소리 없음이고 나머지는 그대로다', () => {
  assert.equal(resolveRendererDropReason('tts_failed'), DROP_REASON_MAP.noAudio);
  assert.equal(resolveRendererDropReason('expired'), 'expired');
  assert.equal(resolveRendererDropReason(''), null);
});

test('들린 순간의 캡처 벽시계: 교차 모드는 지연 재생만큼 앞이고, 위치를 모르면 null 이다', () => {
  assert.equal(resolvePlayedWallMs({ wallMs: 50_000, playbackVideoTimeMs: 20_000, liveVideoTimeMs: 30_000, mode: 'delayed' }), 40_000);
  assert.equal(resolvePlayedWallMs({ wallMs: 50_000, playbackVideoTimeMs: 0, liveVideoTimeMs: 30_000, mode: 'delayed' }), null);
  assert.equal(resolvePlayedWallMs({ wallMs: 50_000, playbackVideoTimeMs: null, liveVideoTimeMs: null }), 50_000);
});

test('캡처 시작 벽시계는 재생 알림의 (벽시계 − 영상 시각) 중앙값이고, 알림이 없으면 캡처 요청 시각이다', () => {
  const playbackList = [{ wallMs: 10_000, liveVideoTimeMs: 4000 }, { wallMs: 20_000, liveVideoTimeMs: 13_000 }, { wallMs: 30_000, liveVideoTimeMs: 24_500 }];
  assert.equal(resolveCaptureStartWallMs({ playbackList }), 6000);
  assert.equal(resolveCaptureStartWallMs({ captureRequestedWallMs: 777, playbackList: [] }), 777);
});

test('받아쓰기 조각은 세그먼트마다 영상 시각 발화로 바뀐다', () => {
  assert.deepEqual(buildTranscriptUtteranceList({
    asrEventList: [{ ts: 1000, endTs: 4000, text: '가 나', segmentList: [{ startSec: 0, endSec: 1, text: '가' }, { startSec: 1.5, endSec: 3, text: '나' }] }],
    toMediaMs: (wallMs) => wallMs - 1000,
  }), [{ startMs: 0, endMs: 1000, text: '가' }, { startMs: 1500, endMs: 3000, text: '나' }]);
});
