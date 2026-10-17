import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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
