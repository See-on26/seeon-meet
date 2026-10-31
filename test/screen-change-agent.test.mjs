import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assembleNarration } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const {
  createScreenChangeAgent, SCREEN_CHANGE_AGENT_MAX_TOKENS, SCREEN_CHANGE_AGENT_TEMPERATURE,
} = require('../src/main/caption-pipeline/agents/screen-change-agent.js');
const { buildScreenChangePrompt } = require('../src/main/caption-pipeline/prompts/screen-change.js');
const { createAgentFieldMap } = require('../src/main/caption-pipeline/agents/index.js');

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

const promptText = () => requestBodyList[0].messages[0].content.find((block) => block.type === 'text').text;

test('새로 뜬 글자 해설은 "새로 표시, {대상} {값}", 강조는 "강조 표시, {대상}"으로 조립한다', () => {
  const shown = assembleNarration({
    narrationType: 'screen_change', subKind: 'new_text', rawSlotMap: { target: '3분기 매출', value: '42억 원' },
  });
  assert.equal(shown.text, '새로 표시, 3분기 매출 42억 원');
  const highlighted = assembleNarration({
    narrationType: 'screen_change', subKind: 'highlight', rawSlotMap: { target: '보기 3번 서울' },
  });
  assert.equal(highlighted.text, '강조 표시, 보기 3번 서울');
});

test('영어 캡션은 "Now shown:"·"Highlighted:" 머리말을 붙인다', () => {
  const shown = assembleNarration({
    narrationType: 'screen_change', subKind: 'new_text', rawSlotMap: { target: 'Q3 revenue', value: '4.2 billion won' }, language: 'en',
  });
  assert.equal(shown.text, 'Now shown: Q3 revenue 4.2 billion won');
  const highlighted = assembleNarration({
    narrationType: 'screen_change', subKind: 'highlight', rawSlotMap: { target: 'option 3' }, language: 'en',
  });
  assert.equal(highlighted.text, 'Highlighted: option 3');
});

test('값 칸이 비면 새로 뜬 글자 해설을 만들지 않는다', () => {
  assert.equal(assembleNarration({
    narrationType: 'screen_change', subKind: 'new_text', rawSlotMap: { target: '3분기 매출', value: '' },
  }), null);
});

test('프롬프트는 테두리의 뜻·새로 읽힌 줄·이미 들은 말·이미 안내한 것·NONE 조건을 담는다', () => {
  const prompt = buildScreenChangePrompt({
    eventKind: 'new_text', lineList: ['매출 42억', '전년 대비 12%'], recentTranscript: '자 다음 결과를 보시면',
    describedElementList: ['슬라이드 2: 분기 실적 표'], imageMode: 'outline',
  });
  assert.match(prompt, /테두리는 시스템이 그린 표시/);
  assert.match(prompt, /매출 42억\n전년 대비 12%/);
  assert.match(prompt, /이미 들은 말/);
  assert.match(prompt, /자 다음 결과를 보시면/);
  assert.match(prompt, /슬라이드 2: 분기 실적 표/);
  assert.match(prompt, /반올림·어림하지 않고/);
  assert.match(prompt, /커서·메뉴·알림 창/);
  assert.match(prompt, /"target"/);
  assert.match(prompt, /"value"/);
  assert.doesNotMatch(prompt, /새로 강조된/);
});

test('강조 프롬프트는 항목 이름만 받는다', () => {
  const prompt = buildScreenChangePrompt({ eventKind: 'highlight', lineList: [], imageMode: 'outline' });
  assert.match(prompt, /새로 강조된/);
  assert.match(prompt, /"target"/);
  assert.doesNotMatch(prompt, /"value"/);
});

test('최근 발화는 150자, 새로 읽힌 줄은 6줄·200자까지만 넣는다', () => {
  const longTranscript = '가'.repeat(400);
  const lineList = Array.from({ length: 10 }, (_, index) => `${index}번 줄 ${'나'.repeat(30)}`);
  const prompt = buildScreenChangePrompt({ eventKind: 'new_text', lineList, recentTranscript: longTranscript });
  assert.ok(prompt.includes('가'.repeat(150)));
  assert.ok(!prompt.includes('가'.repeat(151)));
  assert.ok(prompt.includes('4번 줄'));
  assert.ok(!prompt.includes('5번 줄'), '35자 줄 다섯 개(175자) 뒤 여섯째는 200자를 넘는다');

  const shortLineList = Array.from({ length: 10 }, (_, index) => `값${index} ${index}%`);
  const shortPrompt = buildScreenChangePrompt({ eventKind: 'new_text', lineList: shortLineList });
  assert.ok(shortPrompt.includes('값5 5%'));
  assert.ok(!shortPrompt.includes('값6 6%'), '줄은 6개까지');
});

test('영어 캡션이면 출력 언어 규칙을 붙인다', () => {
  const prompt = buildScreenChangePrompt({ eventKind: 'new_text', lineList: ['매출 42억'], language: 'en' });
  assert.match(prompt, /\[출력 언어\]/);
});

test('에이전트는 VLM 을 한 번 부르고 해설·칸을 돌려준다', async () => {
  mockVlm('{"target":"3분기 매출","value":"42억 원"}');
  const agent = createScreenChangeAgent({ config: vlmConfig });
  const result = await agent.generate({ jpegBuffer: Buffer.from('x'), eventKind: 'new_text', lineList: ['3분기 매출 42억 원'] });
  assert.equal(requestBodyList.length, 1);
  assert.equal(requestBodyList[0].temperature, SCREEN_CHANGE_AGENT_TEMPERATURE);
  assert.equal(requestBodyList[0].max_tokens, SCREEN_CHANGE_AGENT_MAX_TOKENS);
  assert.equal(result.isGrounded, true);
  assert.equal(result.text, '새로 표시, 3분기 매출 42억 원');
  assert.deepEqual(result.slotMap, { target: '3분기 매출', value: '42억 원' });
});

test('NONE 이면 거절 이유를 돌려주고, JSON 이 아닌 글이면 형식 오류로 버린다', async () => {
  mockVlm('NONE: 테두리 안이 재생 조작 버튼이다');
  const agent = createScreenChangeAgent({ config: vlmConfig });
  const none = await agent.generate({ jpegBuffer: Buffer.from('x'), eventKind: 'new_text', lineList: ['00:12'] });
  assert.equal(none.isGrounded, false);
  assert.equal(none.rejectKind, 'none');
  assert.match(none.rejectReason, /재생 조작/);

  requestBodyList = [];
  mockVlm('3분기 매출이 42억 원으로 새로 표시되었습니다');
  const plain = await agent.generate({ jpegBuffer: Buffer.from('x'), eventKind: 'new_text', lineList: ['42억'] });
  assert.equal(plain.isGrounded, false);
  assert.equal(plain.rejectKind, 'format');
});

test('에이전트 표에 화면 변화 에이전트가 있다', () => {
  const agentFieldMap = createAgentFieldMap({ config: vlmConfig });
  assert.equal(typeof agentFieldMap.screen_change.generate, 'function');
});
