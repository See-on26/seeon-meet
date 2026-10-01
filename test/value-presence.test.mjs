import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isValuePresent, VALUE_PRESENCE_VERDICT_MAP } = require('../src/main/caption-pipeline/orchestrator/value-presence.js');

const ready = 'ready';
const slideText = '2분기 매출 | 120억 원\n재구매율 73 %\n처리량 1200건\n배율 11.8배';

test('화면에 있는 값은 present (공백·단위 차이 무시)', () => {
  const verdict = isValuePresent({ value: '73%', slideText, slideTextStatus: ready, subKind: 'claim_to_value' });
  assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.present);
});

test('쉼표 표기 차이를 무시한다', () => {
  const verdict = isValuePresent({ value: '1,200건', slideText, slideTextStatus: ready, subKind: 'claim_to_value' });
  assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.present);
});

test('화면에 없는 값은 absent', () => {
  const verdict = isValuePresent({ value: '80%', slideText, slideTextStatus: ready, subKind: 'claim_to_value' });
  assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.absent);
  assert.match(verdict.reason, /80/);
});

test('다른 수의 일부만 겹치는 것은 같은 값이 아니다', () => {
  assert.equal(isValuePresent({ value: '1.8배', slideText, slideTextStatus: ready, subKind: 'claim_to_value' }).verdict, 'absent');
  assert.equal(isValuePresent({ value: '73', slideText: '수치 73.5', slideTextStatus: ready, subKind: 'claim_to_value' }).verdict, 'absent');
  assert.equal(isValuePresent({ value: '20억', slideText: '120억 원', slideTextStatus: ready, subKind: 'claim_to_value' }).verdict, 'absent');
});

test('value_to_meaning 은 발화에 있는 값도 인정한다', () => {
  const verdict = isValuePresent({
    value: '30%', slideText: '재구매율 그래프', utterance: '보시는 것처럼 30%예요',
    slideTextStatus: ready, subKind: 'value_to_meaning',
  });
  assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.present);
});

test('claim_to_value 는 발화에만 있는 값을 인정하지 않는다', () => {
  const verdict = isValuePresent({
    value: '30%', slideText: '재구매율 그래프', utterance: '30%예요',
    slideTextStatus: ready, subKind: 'claim_to_value',
  });
  assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.absent);
});

test('아라비아 숫자가 없으면 검사하지 않는다', () => {
  const verdict = isValuePresent({ value: '세 단계', slideText, slideTextStatus: ready, subKind: 'claim_to_value' });
  assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.unchecked);
});

test('전사가 준비되지 않았으면 막지 않고 unchecked', () => {
  for (const status of ['pending', 'failed', 'none', 'missing']) {
    const verdict = isValuePresent({ value: '80%', slideText: '', slideTextStatus: status, subKind: 'claim_to_value' });
    assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.unchecked, status);
    assert.match(verdict.reason, new RegExp(status));
  }
});

test('value_to_meaning 은 앞뒤 발화(맥락)에 있는 값도 인정한다', () => {
  const verdict = isValuePresent({
    value: '30%', slideText: '재구매율 그래프', utterance: '많이 늘었습니다',
    contextText: '올해 재구매율이 30%였고요', slideTextStatus: ready, subKind: 'value_to_meaning',
  });
  assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.present);
});

test('발화가 한글 수사로 전사됐으면 값→의미는 막지 않는다', () => {
  assert.equal(isValuePresent({
    value: '73%', slideText: '재구매율 그래프', utterance: '칠십삼 퍼센트입니다',
    slideTextStatus: ready, subKind: 'value_to_meaning',
  }).verdict, VALUE_PRESENCE_VERDICT_MAP.unchecked);
  assert.equal(isValuePresent({
    value: '2배', slideText: '매출 그래프', utterance: '두 배 늘었습니다',
    slideTextStatus: ready, subKind: 'value_to_meaning',
  }).verdict, VALUE_PRESENCE_VERDICT_MAP.unchecked);
});

test('claim_to_value 는 맥락·한글 수사가 있어도 화면만 본다', () => {
  assert.equal(isValuePresent({
    value: '30%', slideText: '재구매율 그래프', utterance: '두 배 늘었습니다', contextText: '30%',
    slideTextStatus: ready, subKind: 'claim_to_value',
  }).verdict, VALUE_PRESENCE_VERDICT_MAP.absent);
});
