import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  readPipelineConfig, FACT_CARD_AGENT_LIST, DEFAULT_FACT_CARD_AGENT_LIST,
} = require('../src/main/caption-pipeline/config.js');

// 화면 사실 카드 스위치. 제품 기본은 꺼짐이고, 실험실은 env 로 켠다. 모르는 값이면 경고하고 기본값으로 둔다.
afterEach(() => mock.restoreAll());

test('기본: 카드 꺼짐, 받는 에이전트는 수치·척도, JSON 은 프롬프트로 받는다. 경고하지 않는다', () => {
  const warn = mock.method(console, 'warn', () => {});
  for (const env of [{}, { SEEON_FACT_CARD: '', SEEON_FACT_CARD_AGENTS: '', SEEON_FACT_CARD_JSON_MODE: '' }]) {
    const config = readPipelineConfig(env);
    assert.equal(config.isFactCardEnabled, false);
    assert.deepEqual(config.factCardAgentList, ['interpretation', 'scale']);
    assert.equal(config.factCardJsonMode, 'prompt');
  }
  assert.deepEqual(FACT_CARD_AGENT_LIST, ['interpretation', 'scale', 'deixis']);
  assert.deepEqual(DEFAULT_FACT_CARD_AGENT_LIST, ['interpretation', 'scale']);
  assert.equal(warn.mock.callCount(), 0);
});

test('SEEON_FACT_CARD: on·off 만 받는다', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(readPipelineConfig({ SEEON_FACT_CARD: 'on' }).isFactCardEnabled, true);
  assert.equal(readPipelineConfig({ SEEON_FACT_CARD: 'off' }).isFactCardEnabled, false);
  assert.equal(warn.mock.callCount(), 0);
  for (const value of ['yes', 'true', 'ON', '1']) {
    assert.equal(readPipelineConfig({ SEEON_FACT_CARD: value }).isFactCardEnabled, false, value);
  }
  assert.equal(warn.mock.callCount(), 4);
  assert.match(warn.mock.calls[0].arguments[0], /SEEON_FACT_CARD="yes"/);
});

test('SEEON_FACT_CARD_AGENTS: 쉼표 목록(앞뒤 공백 무시), 모르는 이름은 경고하고 빼며 남는 게 없으면 기본값', () => {
  const warn = mock.method(console, 'warn', () => {});
  const listOf = (value) => readPipelineConfig({ SEEON_FACT_CARD_AGENTS: value }).factCardAgentList;
  assert.deepEqual(listOf('interpretation,scale,deixis'), ['interpretation', 'scale', 'deixis']);
  assert.deepEqual(listOf(' deixis , interpretation '), ['deixis', 'interpretation']);
  assert.deepEqual(listOf('scale,scale'), ['scale']);
  assert.equal(warn.mock.callCount(), 0);
  assert.deepEqual(listOf('deixis,foo'), ['deixis']);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /SEEON_FACT_CARD_AGENTS.*foo/);
  assert.deepEqual(listOf('foo'), ['interpretation', 'scale']);
  assert.deepEqual(listOf(' , '), ['interpretation', 'scale']);
});

test('SEEON_FACT_CARD_JSON_MODE: prompt 만 받는다(json_schema 출력 모드는 서버에서 시험하지 않아 쓰지 않는다)', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(readPipelineConfig({ SEEON_FACT_CARD_JSON_MODE: 'prompt' }).factCardJsonMode, 'prompt');
  assert.equal(warn.mock.callCount(), 0);
  for (const value of ['schema', 'json_schema', 'x']) {
    assert.equal(readPipelineConfig({ SEEON_FACT_CARD_JSON_MODE: value }).factCardJsonMode, 'prompt', value);
  }
  assert.equal(warn.mock.callCount(), 3);
  assert.match(warn.mock.calls[0].arguments[0], /SEEON_FACT_CARD_JSON_MODE="schema"/);
});
