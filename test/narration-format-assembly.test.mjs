import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assembleNarration, getSlotList } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');

const assemble = ({ narrationType, subKind, rawSlotMap }) => assembleNarration({ narrationType, subKind, rawSlotMap })?.text ?? null;

test('변화·비교 해설은 "대상, 근거 값" 으로 말한다(발화 문장을 붙이지 않는다)', () => {
  // 읽히는 칸은 대상·값 둘이다(근거 줄 칸 source 는 읽지 않는다).
  assert.deepEqual(getSlotList({ narrationType: 'interpretation', subKind: 'claim_to_value' })
    .filter((slot) => !slot.isDiagnostic).map((slot) => slot.key), ['target', 'value']);
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

test('수치 해설의 해석틀이 상한보다 길면 앞 꾸밈말을 버리고 끝의 핵심 명사구를 남긴다', () => {
  const meaning = (frame, isFactCompleteEnabled) => assembleNarration({ narrationType: 'interpretation',
    subKind: 'value_to_meaning', rawSlotMap: { value: '75%', frame }, contentSwitch: { isFactCompleteEnabled } })?.text;
  // 사실 완결을 끄면 해석틀 칸 상한은 5어절이다.
  assert.equal(meaning('팬데믹 이후 화상회의로 영구 전환된 기업 회의 비중', false), '75%는 영구 전환된 기업 회의 비중을 의미',
    '앞에서 자르면 핵심 명사(비중)가 빠지고 "영구를 의미"처럼 뜻이 틀어진다');
  assert.equal(meaning('화상회의로 영구 전환된 기업 회의 비중', false), '75%는 영구 전환된 기업 회의 비중을 의미');
  assert.equal(meaning('올해 1분기 작년 대비 A사 기업가치 성장률', false), '75%는 작년 대비 A사 기업가치 성장률을 의미');
  // 사실 완결을 켜면 비교 상대·시점을 담으려고 상한이 6어절이지만, 넘칠 때 앞을 버리는 것은 같다.
  assert.equal(meaning('팬데믹 이후 화상회의로 영구 전환된 기업 회의 비중', true), '75%는 화상회의로 영구 전환된 기업 회의 비중을 의미',
    '앞에서 자르면 "…기업을 의미"처럼 뜻이 틀어진다');
  assert.equal(meaning('올해 1분기 작년 대비 A사 기업가치 성장률', true), '75%는 1분기 작년 대비 A사 기업가치 성장률을 의미');
});

test('지시 해설은 상황 칸 없이 대상 내용(caption)만 읽는다', () => {
  assert.equal(assemble({ narrationType: 'deixis', subKind: 'simple',
    rawSlotMap: { seen: '응답 품질 변화 표', caption: '응답 품질 변화 표' } }), '응답 품질 변화 표');
  assert.equal(assemble({ narrationType: 'deixis', subKind: 'simple',
    rawSlotMap: { target: '응답 품질 변화 표', situation: '보는 중' } }), null, '옛 칸으로 온 답은 caption 이 없어 만들지 않는다');
});
