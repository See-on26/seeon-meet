import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildFlowView } = require('../src/main/dev-flow/flow-builder.js');

const BASE_MS = 1_000_000;
const at = (offsetMs) => BASE_MS + offsetMs;
const debug = (offsetMs, stage, verdict, reason, detail = '', narrationType = null) => ({
  kind: 'debug', stage, verdict, reason, detail, narrationType, ts: at(offsetMs),
});
const CHANGE_TEXT = '새로 표시, 3분기 매출 42억 원';

function buildInput() {
  return {
    debugList: [
      debug(0, 'session', 'info', '세션 시작', '모드=delayed · 화면 변화=same_slide'),
      debug(1000, 'screen_change', 'info', '화면 변화 기준 화면 잡음(슬라이드 시작)', '슬라이드=2 OCR 400ms 줄 5'),
      debug(5000, 'screen_change', 'pass', '화면 변화 same_slide/new_text → emitted', '슬라이드=2 영역=0.10,0.60,0.40,0.08 칸=10', 'screen_change'),
      debug(5000, 'tts', 'pass', '합성 완료', `120KB · "${CHANGE_TEXT}"`, 'screen_change'),
      debug(9000, 'screen_change', 'skip', '화면 변화 same_slide/new_text → skipped (spoken)', '슬라이드=2 영역=0.10,0.70,0.30,0.08', 'screen_change'),
      debug(9500, 'screen_change', 'info', '화면 변화 감지기 거름(30초 집계)', 'too_small=4 reverted=1'),
    ],
    captionEventList: [
      { type: 'caption', ts: at(5000), text: CHANGE_TEXT, source: 'screen_change', narrationClass: 'screen_change' },
    ],
    playbackList: [
      { ts: at(5000), text: CHANGE_TEXT, wallMs: at(6000), durationMs: 2000, playbackVideoTimeMs: null, liveVideoTimeMs: null },
    ],
    droppedList: [],
    toMediaMs: (wallMs) => wallMs - BASE_MS,
    isFinal: true,
  };
}

test('흐름 창은 화면 변화 사건을 화면 변화 흐름으로 묶고, 기준 화면·감지기 집계는 머리 영역에 둔다', () => {
  const view = buildFlowView(buildInput());
  const changeFlowList = view.flowList.filter((flow) => flow.typeKey === 'screen_change');
  assert.equal(changeFlowList.length, 2);
  assert.equal(changeFlowList[0].typeLabel, '화면 변화');
  assert.ok(changeFlowList[0].stepList.some((step) => step.label === '화면 변화 설명 에이전트'));
  assert.equal(view.flowList.length, 2);
  assert.ok(view.sessionInfoList.some((info) => /기준 화면/.test(info.reason)));
  assert.ok(view.sessionInfoList.some((info) => /감지기 거름/.test(info.reason)));
});
