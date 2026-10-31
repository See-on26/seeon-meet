import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describeOutcomeReason } from '../src/renderer/dev-flow/flow-view.js';
import { QUEUE_DROP_LABEL_MAP } from '../src/renderer/core/audio-renderer/narration-queue.js';

const require = createRequire(import.meta.url);
const { buildFlowView, OUTCOME_KIND_MAP } = require('../src/main/dev-flow/flow-builder.js');

// 기술 스택 점검표 댓글 #19: 통과하지 못한 흐름은 근거가 자연어로 보여야 한다.
// 단계마다 근거는 있었지만 카드 머리 줄이 "후보 없음 (no_gap)"·"expired" 같은 코드값을 보였다.
const BASE_MS = 1_000_000;
const at = (offsetMs) => BASE_MS + offsetMs;
const debug = (offsetMs, stage, verdict, reason, detail = '', narrationType = null) => ({
  kind: 'debug', stage, verdict, reason, detail, narrationType, ts: at(offsetMs),
});

function buildJudgeBlockedFlow(judgeDetail) {
  const view = buildFlowView({
    debugList: [
      debug(1000, 'router', 'info', '트리거 후보 1개 (rule)', '지시대명사:"여기" · 전사="여기 부분을 보시면"'),
      debug(1000, 'screen_dependency', 'pass', '발화 지시가 트리거', '근거="여기"', 'deixis'),
      debug(1000, 'budget', 'pass', '지시 후보 발행', '트리거="여기" 발화="여기 부분을 보시면"'),
      debug(1000, 'router', 'skip', '판단 LLM 0/1 공백', judgeDetail),
      debug(1000, 'router', 'skip', '후보 없음 (no_gap)', '발화="여기 부분을 보시면" 후보=[없음] 경로=gpu'),
    ],
    toMediaMs: (wallMs) => wallMs - BASE_MS,
    isFinal: true,
  });
  return view.flowList[0];
}

test('판단 LLM 이 공백이 아니라고 해 막힌 흐름은 후보마다 판단 LLM 이 쓴 이유를 머리 줄 사유로 보인다', () => {
  const flow = buildJudgeBlockedFlow('지시대명사:"여기"=X(바로 뒤 발화가 무늬가 몰린 부분이라고 밝힌다)');
  assert.equal(flow.outcome.kind, OUTCOME_KIND_MAP.blocked);
  assert.equal(flow.outcome.reason, '판단 LLM이 공백 아니라고 봄 — 지시대명사 "여기": 바로 뒤 발화가 무늬가 몰린 부분이라고 밝힌다');
});

test('후보가 여럿이면 공백 아님(X) 후보의 이유만 차례로 잇는다', () => {
  const flow = buildJudgeBlockedFlow('지시대명사:"이것"=X(앞에서 밝힘) · 단순 수치:"30%"=X(무엇의 수치인지 말함)');
  assert.equal(flow.outcome.reason, '판단 LLM이 공백 아니라고 봄 — 지시대명사 "이것": 앞에서 밝힘 / 단순 수치 "30%": 무엇의 수치인지 말함');
});

test('후보마다 판단 기록이 없는 막힘은 그 단계의 사유를 그대로 둔다', () => {
  const view = buildFlowView({
    debugList: [
      debug(1000, 'screen_dependency', 'pass', '발화 지시가 트리거', '근거="이 부분"', 'deixis'),
      debug(1000, 'budget', 'pass', '지시 후보 발행', '트리거="이 부분" 발화="이 부분이 핵심"'),
      debug(1000, 'router', 'skip', '후보 없음 (abstract)', '발화="이 부분이 핵심" 후보=[없음] 경로=gpu'),
    ],
    toMediaMs: (wallMs) => wallMs - BASE_MS,
    isFinal: true,
  });
  assert.equal(view.flowList[0].outcome.reason, '후보 없음 (abstract)');
});

test('버려진 이유 코드는 흐름 창에서 문장으로 보인다(기록 파일의 코드값은 그대로)', () => {
  assert.equal(describeOutcomeReason('expired'), QUEUE_DROP_LABEL_MAP.expired);
  assert.equal(describeOutcomeReason('stale'), QUEUE_DROP_LABEL_MAP.stale);
  assert.equal(describeOutcomeReason('rate-limited'), '비슷한 해설이 방금 나가 간격 억제');
  assert.equal(describeOutcomeReason('not_played'), '끝날 때까지 재생되지 않음');
  assert.equal(describeOutcomeReason('feature_off'), '기능 꺼짐 — 내보내지 않음');
  assert.equal(describeOutcomeReason('no_audio'), 'TTS 합성 실패 — 소리 없음');
  assert.equal(describeOutcomeReason('duplicate:같은 슬라이드 대상'), '앞 해설과 같은 내용이라 막힘(같은 슬라이드 대상)');
  assert.equal(describeOutcomeReason('이 슬라이드에서 이미 무발화 해설을 냄'), '이 슬라이드에서 이미 무발화 해설을 냄', '이미 문장인 사유는 그대로');
  assert.equal(describeOutcomeReason(null), '');
});

test('흐름 창은 카드 머리 줄과 해설별 결과의 사유를 문장으로 바꿔 보인다', () => {
  const source = fs.readFileSync(new URL('../src/renderer/dev-flow/flow.js', import.meta.url), 'utf8');
  assert.match(source, /describeOutcomeReason\(caption\.reason\)/);
  assert.match(source, /describeOutcomeReason\(flow\.outcome\.reason\)/);
});
