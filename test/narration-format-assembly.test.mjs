import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assembleNarration, getSlotList } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');

const assemble = ({ narrationType, subKind, rawSlotMap }) => assembleNarration({ narrationType, subKind, rawSlotMap })?.text ?? null;

test('변화·비교 해설은 "대상, 근거 값" 으로 말한다(발화 문장을 붙이지 않는다)', () => {
  assert.deepEqual(getSlotList({ narrationType: 'interpretation', subKind: 'claim_to_value' }).map((slot) => slot.key), ['target', 'value']);
  assert.equal(assemble({ narrationType: 'interpretation', subKind: 'claim_to_value',
    rawSlotMap: { target: '첫 응답 시간', value: '9.2시간에서 3.1시간' } }), '첫 응답 시간, 9.2시간에서 3.1시간');
  assert.equal(assemble({ narrationType: 'interpretation', subKind: 'claim_to_value',
    rawSlotMap: { target: '8월 낮 최고기온', value: '도심 33.8도 교외 29.1도' } }), '8월 낮 최고기온, 도심 33.8도 교외 29.1도');
});

test('변화·비교 해설의 값 칸에 수치가 없으면 해설을 만들지 않는다', () => {
  assert.equal(assemble({ narrationType: 'interpretation', subKind: 'claim_to_value',
    rawSlotMap: { target: '고객 만족도', value: '크게 오름' } }), null);
});

test('수치 해설(수치 → 뜻)은 지금처럼 "값은 해석틀을 의미" 로 말한다', () => {
  assert.equal(assemble({ narrationType: 'interpretation', subKind: 'value_to_meaning',
    rawSlotMap: { value: '73%', frame: '작년 대비 재고 회전율' } }), '73%는 작년 대비 재고 회전율을 의미');
});

// 효과영상 레이블(2026-10-17)의 지시 정답은 모두 "보는 중" 같은 상황 말 없이 대상 내용만이다.
test('지시 해설은 caption(대상 내용)만 읽고, 근거 칸 seen 은 읽지 않는다', () => {
  for (const subKind of ['simple', 'complete']) {
    assert.deepEqual(getSlotList({ narrationType: 'deixis', subKind }).map((slot) => slot.key), ['seen', 'caption'], subKind);
    assert.equal(assemble({ narrationType: 'deixis', subKind,
      rawSlotMap: { seen: '배송 지연 412건이라고 적힌 항목', caption: '배송 지연 412건 항목' } }), '배송 지연 412건 항목', subKind);
  }
});

test('지시 해설은 두 어절짜리 대상 이름도 받고, caption 이 비면 만들지 않는다', () => {
  assert.equal(assemble({ narrationType: 'deixis', subKind: 'simple',
    rawSlotMap: { seen: '초코송이라고 적힌 봉지', caption: '초코송이 과자' } }), '초코송이 과자');
  assert.equal(assemble({ narrationType: 'deixis', subKind: 'simple', rawSlotMap: { seen: '빈 배경', caption: '' } }), null);
});

// 효과영상 메일 예시: VLM 은 "요청기한 금일 오후 6시까지"를 냈는데 끝맺음 다듬기가 "6시까지"를 덜 끝난 말로 보고 지웠다.
test('지시 해설 끝의 "6시까지"처럼 숫자에 붙은 기한은 지우지 않는다', () => {
  assert.equal(assemble({ narrationType: 'deixis', subKind: 'simple',
    rawSlotMap: { seen: '요청기한 금일 오후 6시까지', caption: '요청기한 금일 오후 6시까지' } }), '요청기한 금일 오후 6시까지');
  assert.equal(assemble({ narrationType: 'deixis', subKind: 'simple',
    rawSlotMap: { seen: '신청 기간', caption: '신청 기간 3월부터' } }), '신청 기간 3월부터');
  assert.equal(assemble({ narrationType: 'deixis', subKind: 'simple',
    rawSlotMap: { seen: '마감 안내', caption: '제출 마감 오후까지' } }), '제출 마감');
});

test('지시 해설은 14어절까지 받고, 넘치면 끝을 맺을 수 있는 데서 자른다', () => {
  const caption = '1번 할수 붙여 씀, 2번 할 수 띄어 씀, 3번 할수록 붙여 씀, 4번 할 수록 띄어 씀';
  const text = assemble({ narrationType: 'deixis', subKind: 'simple', rawSlotMap: { seen: '네 문장', caption } });
  assert.ok(text.split(' ').length <= 14, text);
  assert.ok(caption.startsWith(text), text);
});
