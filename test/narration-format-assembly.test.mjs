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

test('지시 해설의 상황 칸이 "가리키며" 같은 가리키는 동작이면 "확인 중" 으로 둔다(가리켰다는 사실은 정보가 아니다)', () => {
  assert.equal(assemble({ narrationType: 'deixis', subKind: 'simple',
    rawSlotMap: { target: '배송 지연 412건 항목', situation: '가리키며' } }), '배송 지연 412건 항목 확인 중');
  assert.equal(assemble({ narrationType: 'deixis', subKind: 'simple',
    rawSlotMap: { target: '배송 지연 412건 항목', situation: '가리키며 설명함' } }), '배송 지연 412건 항목 확인 중');
});

test('지시 해설의 다른 상황 칸은 지금처럼 둔다', () => {
  assert.equal(assemble({ narrationType: 'deixis', subKind: 'simple',
    rawSlotMap: { target: '응답 품질 변화 표', situation: '보는 중' } }), '응답 품질 변화 표 보는 중');
  assert.equal(assemble({ narrationType: 'deixis', subKind: 'simple',
    rawSlotMap: { target: '응답 품질 변화 표', situation: '보며' } }), '응답 품질 변화 표 보며 설명함');
});
