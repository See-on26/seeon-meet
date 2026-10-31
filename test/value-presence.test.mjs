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

const { verifyValuePresence } = require('../src/main/caption-pipeline/orchestrator/value-presence.js');

test('저장된 전사에 값이 없으면 지금 화면을 다시 전사해 확인한다 (나중에 나타난 수치)', async () => {
  let retranscribeCount = 0;
  const verdict = await verifyValuePresence({
    value: '45%', subKind: 'claim_to_value', utterance: '많이 올랐죠',
    slideText: '분기별 점유율', slideTextStatus: ready,
    retranscribe: async () => { retranscribeCount += 1; return { text: '분기별 점유율\n3분기 45%', hasText: true }; },
  });
  assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.present);
  assert.equal(verdict.isRetranscribed, true);
  assert.equal(retranscribeCount, 1);
});

test('다시 전사해도 없으면 absent', async () => {
  const verdict = await verifyValuePresence({
    value: '45%', subKind: 'claim_to_value', slideText: '분기별 점유율', slideTextStatus: ready,
    retranscribe: async () => ({ text: '분기별 점유율 30%', hasText: true }),
  });
  assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.absent);
});

test('다시 전사가 실패하거나 글자가 없으면 막지 않는다', async () => {
  const failed = await verifyValuePresence({
    value: '45%', subKind: 'claim_to_value', slideText: '점유율', slideTextStatus: ready,
    retranscribe: async () => { throw new Error('VLM down'); },
  });
  assert.equal(failed.verdict, VALUE_PRESENCE_VERDICT_MAP.unchecked);
  const empty = await verifyValuePresence({
    value: '45%', subKind: 'claim_to_value', slideText: '점유율', slideTextStatus: ready,
    retranscribe: async () => ({ text: '', hasText: false }),
  });
  assert.equal(empty.verdict, VALUE_PRESENCE_VERDICT_MAP.unchecked);
});

test('처음부터 present·unchecked 면 다시 전사하지 않는다', async () => {
  let retranscribeCount = 0;
  const retranscribe = async () => { retranscribeCount += 1; return { text: '', hasText: false }; };
  await verifyValuePresence({ value: '73%', subKind: 'claim_to_value', slideText, slideTextStatus: ready, retranscribe });
  await verifyValuePresence({ value: '80%', subKind: 'claim_to_value', slideText: '', slideTextStatus: 'pending', retranscribe });
  assert.equal(retranscribeCount, 0);
});

// 해설이 본 것과 같은 프레임의 OCR 글자로 먼저 본다. 저장 전사는 슬라이드 확정 순간의 화면이라 낡을 수 있다.
const countingRetranscribe = (result) => {
  const counter = { count: 0 };
  counter.retranscribe = async () => { counter.count += 1; return result; };
  return counter;
};

test('같은 프레임 OCR 글자에 값이 있으면 저장 전사·재전사를 보지 않고 present', async () => {
  const counter = countingRetranscribe({ text: '', hasText: false });
  const verdict = await verifyValuePresence({
    value: '2,318건', subKind: 'claim_to_value', frameText: '신규 가입자\n체험 계정 2,318건은 제외했다',
    slideText: '', slideTextStatus: 'pending', retranscribe: counter.retranscribe,
  });
  assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.present);
  assert.equal(verdict.checkedSource, 'frame_ocr');
  assert.equal(verdict.isRetranscribed, false);
  assert.equal(counter.count, 0);
});

test('같은 프레임 글자에 없으면 저장 전사가 아니라 VLM 재전사로 확인한다', async () => {
  const present = countingRetranscribe({ text: '체험 계정 2,318건', hasText: true });
  const confirmed = await verifyValuePresence({
    value: '2,318건', subKind: 'claim_to_value', frameText: '체험 계정 2.318건',
    slideText: '체험 계정 2,318건', slideTextStatus: ready, retranscribe: present.retranscribe,
  });
  assert.equal(present.count, 1, '저장 전사에 있어도 재전사로 확인한다');
  assert.equal(confirmed.verdict, VALUE_PRESENCE_VERDICT_MAP.present);
  assert.equal(confirmed.checkedSource, 'frame_ocr');
  assert.equal(confirmed.isRetranscribed, true);
  const absent = countingRetranscribe({ text: '지역별 신규 가입자 4,870명', hasText: true });
  const rejected = await verifyValuePresence({
    value: '2,318건', subKind: 'claim_to_value', frameText: '', slideText: '', slideTextStatus: 'pending',
    retranscribe: absent.retranscribe,
  });
  assert.equal(absent.count, 1, '믿을 줄이 없는 같은 프레임 글자(빈 문자열)도 재전사로 확인한다');
  assert.equal(rejected.verdict, VALUE_PRESENCE_VERDICT_MAP.absent);
});

test('같은 프레임 글자로 본 값→의미도 발화·맥락에 있는 값은 인정한다', async () => {
  const counter = countingRetranscribe({ text: '', hasText: false });
  const verdict = await verifyValuePresence({
    value: '79개', subKind: 'value_to_meaning', utterance: '79개, 이 숫자가 의미가 큽니다.', frameText: 'RSU 설치',
    slideTextStatus: 'pending', retranscribe: counter.retranscribe,
  });
  assert.equal(verdict.verdict, VALUE_PRESENCE_VERDICT_MAP.present);
  assert.equal(counter.count, 0);
});

test('같은 프레임 글자가 없으면(null) 지금처럼 저장 전사 → 재전사', async () => {
  const counter = countingRetranscribe({ text: '', hasText: false });
  const stored = await verifyValuePresence({
    value: '73%', subKind: 'claim_to_value', frameText: null, slideText, slideTextStatus: ready, retranscribe: counter.retranscribe,
  });
  assert.equal(stored.verdict, VALUE_PRESENCE_VERDICT_MAP.present);
  assert.equal(stored.checkedSource, 'slide_text');
  const pending = await verifyValuePresence({
    value: '80%', subKind: 'claim_to_value', slideText: '', slideTextStatus: 'pending', retranscribe: counter.retranscribe,
  });
  assert.equal(pending.verdict, VALUE_PRESENCE_VERDICT_MAP.unchecked);
  assert.equal(counter.count, 0);
});
