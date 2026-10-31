import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseSlotCaption, buildSlotOutputInstruction, describeAgentRejection, REJECT_KIND_MAP,
} = require('../src/main/caption-pipeline/agents/shared/caption-parser.js');
const { createDeixisResolutionAgent } = require('../src/main/caption-pipeline/agents/deixis-resolution-agent.js');
const { createInterpretiveBridgeAgent } = require('../src/main/caption-pipeline/agents/interpretive-bridge-agent.js');
const { createVisualDescriptionAgent } = require('../src/main/caption-pipeline/agents/visual-description-agent.js');
const { createSilenceNarrator, SILENCE_RESULT_MAP } = require('../src/main/caption-pipeline/orchestrator/silence-narrator.js');
const { createSilenceNarrationGate } = require('../src/main/caption-pipeline/orchestrator/silence-gate.js');

const deixisSimple = { narrationType: 'deixis', subKind: 'simple', maxChars: 60, maxWordCount: 8 };
const REASON = '(가) 가리킨 대상을 화면에서 특정할 수 없다 — 가리킨 곳에 읽을 글자가 없음';

test('에이전트가 "NONE: 이유"로 거절하면 이유를 읽어 둔다', () => {
  const result = parseSlotCaption({ content: `NONE: ${REASON}`, ...deixisSimple });
  assert.equal(result.isGrounded, false);
  assert.equal(result.rejectKind, REJECT_KIND_MAP.none);
  assert.equal(result.rejectReason, REASON);
});

test('이유 없이 "NONE"만 오면 거절은 맞지만 이유는 비어 있다', () => {
  const result = parseSlotCaption({ content: 'NONE', ...deixisSimple });
  assert.equal(result.rejectKind, REJECT_KIND_MAP.none);
  assert.equal(result.rejectReason, '');
});

test('JSON 이 잘리거나 칸을 못 채우면 거절이 아니라 형식 오류로 남기고 원문을 둔다', () => {
  const truncated = '{"seen": "지도 위 동쪽 섬", "capt';
  const result = parseSlotCaption({ content: truncated, ...deixisSimple });
  assert.equal(result.isGrounded, false);
  assert.equal(result.rejectKind, REJECT_KIND_MAP.format);
  assert.equal(result.rawContent, truncated);
  const emptySlot = parseSlotCaption({ content: '{"seen": "지도 위 동쪽 섬", "caption": ""}', ...deixisSimple });
  assert.equal(emptySlot.rejectKind, REJECT_KIND_MAP.format);
});

test('한자가 섞여 버린 해설도 그 사유와 원문을 남긴다', () => {
  const content = '{"seen": "中式 메뉴판", "caption": "中式 메뉴"}';
  const result = parseSlotCaption({ content, ...deixisSimple });
  assert.equal(result.rejectKind, REJECT_KIND_MAP.han);
  assert.equal(result.rawContent, content);
});

test('출력 형식 안내는 거절할 때 "NONE: (거절 이유)" 꼴로 이유를 붙이게 한다', () => {
  const instruction = buildSlotOutputInstruction({ narrationType: 'deixis', subKind: 'simple' });
  assert.match(instruction, /NONE: \(거절 이유\)/);
  assert.match(instruction, /"NONE만 출력한다"도 이 꼴/);
  // 공백 판단은 라우터 몫이므로 거절 근거로 발화 판단을 적게 하지 않는다.
  assert.doesNotMatch(instruction, /발화에서 판단/);
  assert.match(instruction, /화면에서 본 것/);
});

test('기록·흐름 창에 쓸 거절 설명: 이유가 있으면 그 이유, 형식 오류·한자는 원문을 함께 보인다', () => {
  assert.deepEqual(describeAgentRejection({ rejectKind: REJECT_KIND_MAP.none, rejectReason: REASON }),
    { reason: `NONE — ${REASON}`, detailPrefix: '' });
  assert.deepEqual(describeAgentRejection({ rejectKind: REJECT_KIND_MAP.none, rejectReason: '' }),
    { reason: 'NONE — 이유를 적지 않음', detailPrefix: '' });
  const format = describeAgentRejection({ rejectKind: REJECT_KIND_MAP.format, rawContent: '{"target": "제주' });
  assert.equal(format.reason, '형식 오류 — 칸을 채우지 못함(잘림·빈 칸·끝맺음)');
  assert.equal(format.detailPrefix, '원문="{"target": "제주" · ');
  assert.equal(describeAgentRejection({ rejectKind: REJECT_KIND_MAP.han, rawContent: '中式' }).reason, '한자 섞임 — 내보내지 않음');
  assert.equal(describeAgentRejection({}).reason, 'NONE — 이유를 적지 않음');
});

const vlmConfig = { vlmUrl: 'http://x', vlmModel: 'm' };
const originalFetch = globalThis.fetch;
let requestBodyList = [];
afterEach(() => { globalThis.fetch = originalFetch; requestBodyList = []; });

function mockVlm(content) {
  globalThis.fetch = async (_url, option) => {
    requestBodyList.push(JSON.parse(option.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
}

test('지시·수치·묘사 에이전트는 거절 이유까지 쓸 수 있게 토큰 상한을 400 으로 두고, 거절 이유를 돌려준다', async () => {
  const jpegBuffer = Buffer.from('x');
  const agentCallList = [
    () => createDeixisResolutionAgent({ config: vlmConfig }).generate({ jpegBuffer, utterance: '여기 이 지역을 보시면', subKind: 'complete' }),
    () => createInterpretiveBridgeAgent({ config: vlmConfig }).generate({ jpegBuffer, utterance: '크게 늘었습니다.', subKind: 'claim_to_value' }),
    () => createVisualDescriptionAgent({ config: vlmConfig }).generate({ jpegBuffer, subKind: 'reaction', origin: 'silence' }),
  ];
  for (const call of agentCallList) {
    mockVlm(`NONE: ${REASON}`);
    const result = await call();
    assert.equal(result.isGrounded, false);
    assert.equal(result.rejectReason, REASON);
  }
  assert.deepEqual(requestBodyList.map((body) => body.max_tokens), [400, 400, 400]);
});

test('무발화 묘사가 거절되면 그 이유를 결과에 싣는다', async () => {
  const narrator = createSilenceNarrator({
    gate: createSilenceNarrationGate(),
    judge: { judge: async () => ({ hasCue: true, reason: 'cue', source: 'rule' }) },
  });
  const result = await narrator.run({
    slideLabel: '1', transcript: '그림을 잠시 보시죠.', silenceMs: 5000,
    describe: async () => ({ isGrounded: false, text: '', rejectKind: REJECT_KIND_MAP.none, rejectReason: '글만 있는 화면' }),
    emit: async () => ({ isEmitted: true }),
  });
  assert.equal(result.status, SILENCE_RESULT_MAP.none);
  assert.equal(result.rejectReason, '글만 있는 화면');
  assert.equal(result.rejectKind, REJECT_KIND_MAP.none);
});
