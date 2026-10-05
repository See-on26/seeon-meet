import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  formatClock, truncateText, filterFlowList, buildTimelineItemList, isNearBottom, MAX_RENDERED_ITEM_COUNT,
} from '../src/renderer/lab/flow/flow-view.js';

const require = createRequire(import.meta.url);
const {
  buildFlowList, buildFlowView, summarizeTrackList, normalizeNarrationType, STEP_KIND_MAP, OUTCOME_KIND_MAP,
} = require('../src/main/lab/flow/flow-builder.js');
const { buildLiveFlowSnapshot } = require('../src/main/lab/flow/flow-snapshot.js');
const { finalizeRun, RESULT_FILE_MAP } = require('../src/main/lab/export/finalize-run.js');
const { createRunRecorder } = require('../src/main/lab/run-recorder.js');

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
    debug(10000, 'router', 'skip', '후보 없음 (abstract)', '발화="이 부분이 오늘의 핵심입니다." 후보=[없음] 경로=bedrock'),
    debug(20000, 'screen_dependency', 'pass', '발화 지시가 트리거', '근거="빨간 막대" 앞맥락 화면 전환 후 10초', 'deixis'),
    debug(20000, 'budget', 'pass', '지시 후보 발행', '트리거="빨간 막대" 발화="빨간 막대들을 보시면" 영역=프레임 전체 슬라이드=2'),
    debug(20000, 'router', 'pass', '확정 deixis/-', '발화="빨간 막대들을 보시면" 후보=[deixis/-] 경로=bedrock', 'deixis'),
    debug(20000, 'vlm', 'pass', '생성 deixis/-', `발화="빨간 막대들을 보시면" → "${DEIXIS_TEXT}" (9376ms, 예산 4~10어절)`, 'deixis'),
    debug(20000, 'tts', 'pass', '합성 완료', `370KB · "${DEIXIS_TEXT}"`, 'deixis'),
    debug(30500, 'gap', 'skip', '후보 틈 없음 → 트리거 지점 삽입', `"${DEIXIS_TEXT}" · 재생 23679ms · 트리거 17012ms`, 'deixis'),
    debug(40000, 'tts', 'pass', '합성 완료', `194KB · "${SILENCE_TEXT}"`, 'visual_description'),
    debug(40000, 'silence', 'pass', '무발화 해설 생성', `"${SILENCE_TEXT}" · 직전 발화="여러분, 이 사진들을 한번 보시죠." 무음=5초 슬라이드=4 (5398ms)`, 'visual_description'),
    debug(45000, 'screen_dependency', 'pass', '발화 지시가 트리거', '근거="이 그래프"', 'deixis'),
    debug(45000, 'budget', 'pass', '지시 후보 발행', '트리거="이 그래프" 발화="이 그래프를 보시면" 영역=프레임 전체'),
    debug(45000, 'router', 'pass', '확정 deixis/-', '발화="이 그래프를 보시면" 후보=[deixis/-] 경로=bedrock', 'deixis'),
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
      { type: 'caption', ts: at(20000), text: DEIXIS_TEXT, source: 'deixis', narrationClass: 'deixis', hasAudio: true },
      { type: 'caption', ts: at(40000), text: SILENCE_TEXT, source: 'visual_description', narrationClass: 'silence_based', hasAudio: true },
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
  assert.equal(flow.stepList[3].label, '경량 LLM 판단(통합 라우터)');
  const agentStep = flow.stepList[4];
  assert.equal(agentStep.label, '지시 대상 설명 에이전트');
  assert.equal(agentStep.text, DEIXIS_TEXT);
  assert.equal(agentStep.elapsedMs, 9376);
  assert.equal(flow.stepList.at(-1).label, '재생됨');
  assert.deepEqual(flow.outcome, { kind: OUTCOME_KIND_MAP.played, reason: null, text: DEIXIS_TEXT, playedMediaMs: 33000 });
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
  assert.deepEqual(flow.outcome, { kind: OUTCOME_KIND_MAP.dropped, reason: 'feature_off', text: TRANSITION_TEXT, playedMediaMs: null });
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
  assert.deepEqual(flow.outcome, { kind: OUTCOME_KIND_MAP.blocked, reason: '후보 없음 (abstract)', text: null, playedMediaMs: null });
});

test('무발화는 무발화 판단과 무발화 에이전트를 거쳐 들리고, 상한에 걸리면 막힌다', () => {
  const flowList = buildFlowList(buildInput());
  const played = findFlow(flowList, 40000);
  assert.equal(played.typeLabel, '무발화');
  assert.deepEqual(stageListOf(played), ['input', 'silence', 'silence', 'tts', 'playback']);
  assert.equal(played.stepList[1].label, '경량 LLM 판단(무발화)');
  assert.equal(played.stepList[2].label, '무발화 기반 설명 에이전트');
  assert.equal(played.stepList[2].text, SILENCE_TEXT);
  assert.equal(played.outcome.playedMediaMs, 41000);
  const blocked = findFlow(flowList, 50000);
  assert.deepEqual(blocked.outcome, { kind: OUTCOME_KIND_MAP.blocked, reason: '분당 1회 상한', text: null, playedMediaMs: null });
});

test('간격 억제로 버려진 해설은 rate-limited 이고, 끝난 실행에서 들리지 않은 해설은 not_played 로 버려진다', () => {
  const live = buildFlowList(buildInput());
  assert.deepEqual(findFlow(live, 45000).outcome, {
    kind: OUTCOME_KIND_MAP.dropped, reason: 'rate-limited', text: RATE_LIMITED_TEXT, playedMediaMs: null,
  });
  const input = buildInput({ playbackList: [] });
  assert.equal(findFlow(buildFlowList(input), 20000).outcome.kind, OUTCOME_KIND_MAP.pending, '실행 중에는 아직 기다린다');
  assert.deepEqual(findFlow(buildFlowList({ ...input, isFinal: true }), 20000).outcome, {
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
  assert.deepEqual(flowList.map((flow) => flow.typeLabel), ['발화 기반(척도·시각)', '발화 기반(수치·변화)']);
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

test('실행 기록기는 viewer 로 온 debug 와 렌더러 debug 를 받은 시각과 함께 모으고 새 실행에서 비운다', () => {
  let nowMs = 500;
  const recorder = createRunRecorder({ now: () => nowMs });
  recorder.addDebug({ stage: 'asr', ts: 1 });
  recorder.start({ runId: 'r', runDir: '/tmp/r', videoPath: '/v.mp4', mode: 'delayed', isEvalPreset: true, featureToggleMap: {} });
  nowMs = 900;
  recorder.addViewerEvent({ type: 'debug', stage: 'vlm', verdict: 'pass', ts: 2 });
  recorder.addDebug({ stage: 'budget', verdict: 'pass', ts: 3 });
  assert.deepEqual(recorder.getRun().debugEventList, [
    { stage: 'vlm', verdict: 'pass', ts: 2, receivedWallMs: 900 },
    { stage: 'budget', verdict: 'pass', ts: 3, receivedWallMs: 900 },
  ]);
  recorder.start({ runId: 'r2', runDir: '/tmp/r2', videoPath: '/v.mp4', mode: 'delayed', isEvalPreset: true, featureToggleMap: {} });
  assert.deepEqual(recorder.getRun().debugEventList, []);
});

test('실행 중 흐름 창 갱신값은 기록기의 debug·해설·재생 알림·시각 보고로 만들고 실행이 없으면 빈 목록이다', () => {
  const emptySnapshot = buildLiveFlowSnapshot({ run: null, nowWallMs: 0 });
  assert.deepEqual({ ...emptySnapshot, trackList: [] }, {
    runId: null, isRecording: false, flowList: [], trackList: [], sessionInfoList: [], asrList: [],
  });
  assert.deepEqual(emptySnapshot.trackList.map((track) => track.state), ['idle', 'idle', 'idle', 'idle', 'idle', 'idle']);
  const input = buildInput();
  const run = {
    runId: 'r', endedAtMs: null,
    debugEventList: input.debugList.map((entry) => ({ ...entry, receivedWallMs: entry.ts })),
    captionEventList: input.captionEventList, playbackList: input.playbackList, rendererDropList: [],
    playerTimeList: [{ wallMs: BASE_MS, mediaMs: 0, paused: false, ended: false }, { wallMs: at(60000), mediaMs: 60000, paused: false, ended: false }],
  };
  const snapshot = buildLiveFlowSnapshot({ run, nowWallMs: at(41500) });
  assert.equal(snapshot.runId, 'r');
  assert.equal(snapshot.isRecording, true);
  assert.equal(snapshot.flowList.length, 6);
  assert.equal(findFlow(snapshot.flowList, 20000).mediaMs, 20000);
  assert.equal(snapshot.trackList.find((track) => track.key === 'output').state, 'active');
  assert.equal(snapshot.asrList.length, 1);
});

function prepareFlowRun() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-flow-'));
  const runDir = path.join(rootDir, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, RESULT_FILE_MAP.outputAudio), 'webm');
  const recordPath = path.join(rootDir, 'pipeline-1.jsonl');
  const recordList = [
    ...buildDebugList().map((entry) => ({ ...entry, sessionId: 'session-1' })),
    { kind: 'narration', ts: at(6040), source: 'page-transition', text: TRANSITION_TEXT, isEmitted: false, skipReason: 'feature_off', sessionId: 'session-1' },
    { kind: 'narration', ts: at(45000), source: 'deixis', text: RATE_LIMITED_TEXT, isEmitted: false, skipReason: 'rate-limited', sessionId: 'session-1' },
  ];
  fs.writeFileSync(recordPath, recordList.map((record) => JSON.stringify(record)).join('\n'));
  const input = buildInput();
  const run = {
    runId: 'run-1', runDir, videoPath: '/v/sample.mp4', videoInfo: null, mode: 'delayed', isEvalPreset: true,
    featureToggleMap: {}, layout: null, git: null, startedAtMs: BASE_MS, endedAtMs: at(70000),
    captureRequestedWallMs: BASE_MS, outputStartWallMs: BASE_MS, outputStopWallMs: at(69000), outputMimeType: 'audio/webm',
    playStartWallMs: BASE_MS, videoEndedWallMs: at(62000), sessionId: 'session-1', recordPath, isSessionEnded: true, roiNormRect: null,
    asrEventList: [], captionEventList: input.captionEventList, playbackList: input.playbackList,
    playerTimeList: [{ wallMs: BASE_MS, mediaMs: 0, paused: false, ended: false }, { wallMs: at(62000), mediaMs: 62000, paused: false, ended: true }],
    rendererDropList: [], debugEventList: [], errorList: [],
  };
  return { runDir, run };
}

test('결과 폴더 마무리는 세션 기록 debug 로 flow.json 을 쓰고 버린 사유는 세션 기록의 것을 쓴다', async () => {
  const { runDir, run } = prepareFlowRun();
  const result = await finalizeRun({ run, modelConfig: {} });
  assert.ok(fs.readdirSync(runDir).includes(RESULT_FILE_MAP.flow));
  assert.equal(RESULT_FILE_MAP.flow, 'flow.json');
  const flowFile = JSON.parse(fs.readFileSync(path.join(runDir, RESULT_FILE_MAP.flow), 'utf8'));
  assert.deepEqual(Object.keys(flowFile).sort(), ['asrList', 'flowList', 'sessionInfoList']);
  assert.deepEqual(flowFile.flowList.map((flow) => [flow.typeKey, flow.outcome.kind, flow.outcome.reason]), [
    ['page_transition', 'dropped', 'feature_off'],
    ['deixis', 'blocked', '후보 없음 (abstract)'],
    ['deixis', 'played', null],
    ['silence', 'played', null],
    ['deixis', 'dropped', 'rate-limited'],
    ['silence', 'blocked', '분당 1회 상한'],
  ]);
  assert.equal(flowFile.flowList[2].mediaMs, 20000);
  assert.equal(flowFile.asrList.length, 1);
  const runInfo = JSON.parse(fs.readFileSync(path.join(runDir, RESULT_FILE_MAP.runInfo), 'utf8'));
  assert.equal(runInfo.counts.flowCount, 6);
  assert.equal(result.isComplete, true);
});

test('flow.json 을 못 써도 다른 결과 파일은 쓰고 오류는 알리기만 한다(결과물 완전성은 그대로)', async () => {
  const { runDir, run } = prepareFlowRun();
  const fsApi = {
    ...fs.promises,
    writeFile: (filePath, ...rest) => (path.basename(filePath) === RESULT_FILE_MAP.flow
      ? Promise.reject(new Error('디스크 가득 참')) : fs.promises.writeFile(filePath, ...rest)),
  };
  const result = await finalizeRun({ run, modelConfig: {}, fsApi });
  assert.deepEqual(result.errorList.map((error) => error.code), ['flow_failed']);
  assert.match(result.errorList[0].message, /flow\.json/);
  assert.equal(result.isComplete, true);
  assert.equal(fs.existsSync(path.join(runDir, RESULT_FILE_MAP.flow)), false);
  assert.ok(fs.existsSync(path.join(runDir, RESULT_FILE_MAP.adTimeline)));
  assert.ok(fs.existsSync(path.join(runDir, RESULT_FILE_MAP.runInfo)));
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
