import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDevFlowRecorder, DEV_FLOW_LIST_LIMIT } = require('../src/main/dev-flow/dev-flow-recorder.js');
const { buildDevFlowSnapshot } = require('../src/main/dev-flow/dev-flow-snapshot.js');
const { flattenPlaybackReport } = require('../src/main/dev-flow/playback-report.js');

// 기술 스택 점검표 댓글 #20: 제품에서 파이프라인이 정상으로 도는지 보는 개발자 모드 흐름 창.
// main 이 이번 회의(캡처 세션) 동안 받은 기록을 모아 두었다가, 창이 열리면 실험실 흐름 창과 같은 흐름으로 보여 준다.
function createClock(startMs = 1_000_000) {
  const clock = { ms: startMs };
  return { clock, now: () => clock.ms };
}

test('세션을 시작하기 전 기록은 버리고, 새 세션을 시작하면 지난 회의 기록을 비운다', () => {
  const { now } = createClock();
  const recorder = createDevFlowRecorder({ now });
  recorder.addDebug({ stage: 'asr', verdict: 'pass', reason: '전사 도착', ts: 1 });
  assert.equal(recorder.getSession(), null);
  recorder.start({ sessionId: 's1', mode: 'delayed' });
  recorder.addDebug({ stage: 'asr', verdict: 'pass', reason: '전사 도착', ts: 2 });
  recorder.start({ sessionId: 's2', mode: 'realtime_mix' });
  assert.deepEqual(recorder.getSession().debugEventList, []);
  assert.equal(recorder.getSession().sessionId, 's2');
});

test('파이프라인 사건은 종류별로 모으고, debug 에는 받은 시각을 붙이며, 캡션의 음성 데이터는 담지 않는다', () => {
  const { clock, now } = createClock();
  const recorder = createDevFlowRecorder({ now });
  recorder.start({ sessionId: 's', mode: 'delayed' });
  clock.ms += 500;
  recorder.addPipelineEvent({ type: 'debug', stage: 'router', verdict: 'pass', reason: '확정', ts: 10 });
  recorder.addPipelineEvent({ type: 'caption', ts: 11, text: '해설', source: 'deixis', wavData: new Uint8Array(4) });
  recorder.addPipelineEvent({ type: 'asr', ts: 12, endTs: 13, text: '말', segmentList: [{ startSec: 0, endSec: 1, text: '말' }], triggerCandidateList: [] });
  recorder.addPipelineEvent({ type: 'summary', text: '요약' });
  recorder.addPlayback({ ts: 11, text: '해설', wallMs: 20 });
  recorder.addRendererDrop({ ts: 11, text: '해설', reason: 'expired' });
  const session = recorder.getSession();
  assert.deepEqual(session.debugEventList, [{ stage: 'router', verdict: 'pass', reason: '확정', ts: 10, receivedWallMs: 1_000_500 }]);
  assert.deepEqual(session.captionEventList, [{ type: 'caption', ts: 11, text: '해설', source: 'deixis' }]);
  assert.deepEqual(session.asrEventList, [{ ts: 12, endTs: 13, text: '말', segmentList: [{ startSec: 0, endSec: 1, text: '말' }] }]);
  assert.equal(session.playbackList.length, 1);
  assert.equal(session.rendererDropList.length, 1);
});

test('긴 회의에서도 종류마다 상한을 넘으면 오래된 기록부터 뺀다', () => {
  const recorder = createDevFlowRecorder({ now: () => 0 });
  recorder.start({ sessionId: 's' });
  for (let index = 0; index < DEV_FLOW_LIST_LIMIT.debug + 3; index += 1) recorder.addDebug({ stage: 'asr', reason: `${index}`, ts: index });
  const { debugEventList } = recorder.getSession();
  assert.equal(debugEventList.length, DEV_FLOW_LIST_LIMIT.debug);
  assert.equal(debugEventList[0].reason, '3');
});

test('세션이 끝나면 끝난 시각을 남기고, 다음 세션 전까지 그 회의 기록을 그대로 둔다', () => {
  const { clock, now } = createClock();
  const recorder = createDevFlowRecorder({ now });
  recorder.start({ sessionId: 's' });
  recorder.addDebug({ stage: 'session', reason: '세션 시작', ts: 1 });
  clock.ms += 1000;
  recorder.markEnded();
  recorder.addDebug({ stage: 'asr', reason: '늦게 온 전사', ts: 2 });
  assert.equal(recorder.getSession().endedAtMs, 1_001_000);
  assert.equal(recorder.getSession().debugEventList.length, 2, '세션 종료 직후 드레인된 기록도 같은 회의 것이다');
});

test('재생 시작 알림은 엔트리를 한 층으로 펴고 들은 위치를 함께 싣는다', () => {
  assert.deepEqual(flattenPlaybackReport({
    entry: { text: '해설', ts: 5, narrationClass: 'deixis' }, durationMs: 900, wallMs: 50, mode: 'delayed',
    playbackVideoTimeMs: 1000, liveVideoTimeMs: 11_000,
  }), {
    text: '해설', ts: 5, narrationClass: 'deixis', durationMs: 900, wallMs: 50, mode: 'delayed',
    playbackVideoTimeMs: 1000, liveVideoTimeMs: 11_000,
  });
  assert.equal(flattenPlaybackReport({ entry: { text: 'x' } }).playbackVideoTimeMs, null);
});

test('흐름 창 갱신값: 세션이 없으면 빈 목록, 있으면 실험실과 같은 흐름이고 시각은 캡처 시작부터 잰다', () => {
  assert.deepEqual(buildDevFlowSnapshot({ session: null, nowWallMs: 0 }).flowList, []);
  const { clock, now } = createClock(5_000_000);
  const recorder = createDevFlowRecorder({ now });
  recorder.start({ sessionId: 'session-1', mode: 'realtime_mix' });
  const at = (offsetMs) => 5_000_000 + offsetMs;
  for (const entry of [
    { stage: 'session', verdict: 'info', reason: '세션 시작', detail: '모드=realtime_mix', ts: at(0) },
    { stage: 'screen_dependency', verdict: 'pass', reason: '발화 지시가 트리거', detail: '근거="이 그래프"', narrationType: 'deixis', ts: at(10_000) },
    { stage: 'budget', verdict: 'pass', reason: '지시 후보 발행', detail: '트리거="이 그래프" 발화="이 그래프를 보시면"', ts: at(10_000) },
    { stage: 'router', verdict: 'pass', reason: '확정 deixis/-', detail: '발화="이 그래프를 보시면" 후보=[deixis/-]', narrationType: 'deixis', ts: at(10_000) },
    { stage: 'vlm', verdict: 'pass', reason: '생성 deixis/-', detail: '발화="이 그래프를 보시면" → "막대 그래프" (900ms)', narrationType: 'deixis', ts: at(10_000) },
  ]) recorder.addPipelineEvent({ type: 'debug', ...entry });
  recorder.addPipelineEvent({ type: 'caption', ts: at(10_000), text: '막대 그래프', source: 'deixis', narrationClass: 'deixis' });
  recorder.addPlayback(flattenPlaybackReport({
    entry: { text: '막대 그래프', ts: at(10_000) }, durationMs: 1500, wallMs: at(12_000), mode: 'realtime_mix',
    playbackVideoTimeMs: null, liveVideoTimeMs: 11_000,
  }));
  clock.ms = at(13_000);
  const snapshot = buildDevFlowSnapshot({ session: recorder.getSession(), nowWallMs: clock.ms });
  assert.equal(snapshot.runId, 'session-1');
  assert.equal(snapshot.isRecording, true);
  assert.equal(snapshot.flowList.length, 1);
  const [flow] = snapshot.flowList;
  assert.equal(flow.outcome.kind, 'played');
  assert.equal(flow.mediaMs, 9000, '캡처 시작(재생 알림 벽시계 − 영상 시각 = +1초)부터 잰다');
  assert.ok(snapshot.trackList.length > 0);
  recorder.markEnded();
  assert.equal(buildDevFlowSnapshot({ session: recorder.getSession(), nowWallMs: clock.ms }).isRecording, false);
});

test('파이프라인 main 은 viewer 로 보내는 사건·렌더러 debug·버림·재생 시작·세션 시작과 끝을 개발자 흐름 기록기에 넘긴다', () => {
  const source = fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');
  assert.equal((source.match(/webContents\.send\('pipeline-event'/g) || []).length, 1, 'pipeline-event 는 한 곳(sendPipelineEvent)에서만 보낸다');
  assert.match(source, /devFlow\.recorder\.addPipelineEvent\(payload\)/);
  assert.match(source, /ipcMain\.on\('pipeline-narration-playback'/);
  assert.match(source, /devFlow\.recorder\.addRendererDrop\(/);
  assert.match(source, /devFlow\.recorder\.start\(\{ sessionId, mode \}\)/);
  assert.match(source, /devFlow\.recorder\.markEnded\(\)/);
});
