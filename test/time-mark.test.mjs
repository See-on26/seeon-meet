import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readContentSwitch, CONTENT_SWITCH_ENV_NAME_MAP } = require('../src/main/caption-pipeline/agents/shared/content-switch.js');
const { isTimeMarkWord, readSingleTimeMark } = require('../src/main/caption-pipeline/agents/shared/time-mark.js');
const { assembleNarration } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { buildGroundingPrompt } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');

// 시점 표기 지키기: 연도·분기·월·주 같은 시점이 대상 칸·해설에서 지워지지 않게 한다.
// 예산 맞추기가 대상 칸 앞쪽 꾸밈말부터 빼면서 맨 앞의 시점이 가장 먼저 사라졌고, 모델도 칸 어절 수를 맞추느라 시점을 뺐다.
// 다른 스위치는 셸 환경변수에 기대지 않게 모두 켠 값으로 고정한다.
const ALL_ON = { isFactCompleteEnabled: true, isTimeMarkEnabled: true, isScreenValueFirstEnabled: true, isScaleValueFirstEnabled: true };
const ON = ALL_ON;
const OFF = { ...ALL_ON, isTimeMarkEnabled: false };

const claim = ({ target, value, source, ...option }) => assembleNarration({
  narrationType: 'interpretation', subKind: 'claim_to_value', rawSlotMap: { source, target, value }, ...option,
})?.text ?? null;
const deixis = (rawSlotMap, option = {}) => assembleNarration({ narrationType: 'deixis', subKind: 'simple', rawSlotMap, ...option })?.text ?? null;

test('스위치: SEEON_TIME_MARK_ENABLED 는 기본 켜짐이고 "false" 일 때만 끈다', () => {
  assert.equal(CONTENT_SWITCH_ENV_NAME_MAP.isTimeMarkEnabled, 'SEEON_TIME_MARK_ENABLED');
  assert.equal(readContentSwitch({}).isTimeMarkEnabled, true);
  assert.equal(readContentSwitch({ SEEON_TIME_MARK_ENABLED: 'false' }).isTimeMarkEnabled, false);
});

test('시점 낱말: 연도·반기·분기·월·주·날짜·상대 시점과 그 범위·나열을 시점으로 본다', () => {
  for (const word of ['2024년', '2024년도', '2024', '2019~2023년', '2023·2024년', '3분기', '1~2분기', '3Q', 'Q3', 'FY2024',
    '상반기', '하반기', '12월', '1~3월', '3월말', '1주차', '52주', '15일', '2024.03', '올해', '작년', '지난해', '전년',
    '2024년의', '2023년까지', '2019년부터', '2024년에는']) {
    assert.equal(isTimeMarkWord(word), true, word);
  }
  for (const word of ['매출', '서울', '1,200명', '73%', '2024명', '3년간', '120억', '신규', '월별', '주간', '대비', '2,024']) {
    assert.equal(isTimeMarkWord(word), false, word);
  }
});

test('근거 칸의 시점: 하나뿐인 절대 시점만 고르고, 둘 이상·상대 시점·비교 기준·꾸밈 없는 네 자리 수는 고르지 않는다', () => {
  assert.equal(readSingleTimeMark('2024년 지점별 매출 표, 서울 120억'), '2024년');
  assert.equal(readSingleTimeMark('2024년 3분기 매출 120억'), '2024년 3분기');
  assert.equal(readSingleTimeMark('기간 2019년부터 2023년까지 강수량'), '2019년부터 2023년까지');
  assert.equal(readSingleTimeMark('2023년 대비 2024년 매출'), '2024년', '"대비" 앞 시점은 비교 기준이다');
  assert.equal(readSingleTimeMark('2024년에 개설한 지점 수'), '2024년', '끝 조사는 뗀다');
  assert.equal(readSingleTimeMark('2023년 매출 100억, 2024년 매출 150억'), null);
  assert.equal(readSingleTimeMark('전년 대비 매출 증가율'), null);
  assert.equal(readSingleTimeMark('서울 1500 부산 2000'), null);
  assert.equal(readSingleTimeMark('지점별 매출 표'), null);
  // 바로 뒤에 값이 오는 시점은 자료 속 항목 이름(막대·칸 이름)이지 대상 전체의 시점이 아니다.
  assert.equal(readSingleTimeMark('분기별 매출 비교 표, 1분기 120억'), null);
  assert.equal(readSingleTimeMark('2024년 매출 표, 1분기 120억, 2분기 150억'), '2024년');
});

test('시점 되살리기: 읽히는 칸이 이미 시간 축(분기별·월별·추이)을 말하면 붙이지 않는다', () => {
  assert.equal(deixis({ seen: '2024년 월별 방문자', caption: '월별 방문자 추이 그래프', fact: '' }, { contentSwitch: ON }),
    '월별 방문자 추이 그래프');
  assert.equal(deixis({ seen: '2024년 지점별 방문자', caption: '지점별 방문자 그래프', fact: '' }, { contentSwitch: ON }),
    '2024년 지점별 방문자 그래프', '지점별은 시간 축이 아니다');
});

test('예산 맞추기: 대상 칸 앞 꾸밈말을 뺄 때 시점 낱말은 남기고, 시점이 아닌 꾸밈말·값 뒤 항목부터 줄인다', () => {
  assert.equal(
    claim({ target: '2024년 서울 신규 가입자', value: '1,200명에서 1,500명', maxWordCount: 5, contentSwitch: ON }),
    '2024년 신규 가입자, 1,200명에서 1,500명',
  );
  assert.equal(
    claim({ target: '2024년 서울 신규 가입자', value: '1,200명에서 1,500명', maxWordCount: 5, contentSwitch: OFF }),
    '서울 신규 가입자, 1,200명에서 1,500명',
  );
  assert.equal(
    claim({ target: '올해 상반기 신규 가입자', value: '서울 1,200명, 부산 800명, 대구 500명', maxWordCount: 6, contentSwitch: ON }),
    '올해 상반기 신규 가입자, 서울 1,200명',
  );
  // 값 항목이 하나만 남아도 넘치면 마지막으로 예전처럼 대상 앞 낱말을 뺀다(끝 2어절은 남긴다).
  assert.equal(
    claim({ target: '2024년 상반기 신규 가입자', value: '1,200명에서 1,500명', maxWordCount: 4, contentSwitch: ON }),
    '신규 가입자, 1,200명에서 1,500명',
  );
});

test('시점 되살리기(지시): seen 에 하나뿐인 시점이 caption·fact 어디에도 없으면 caption 앞에 붙인다', () => {
  assert.equal(deixis({ seen: '2024년 지점별 매출 표, 서울 120억', caption: '지점별 매출 표', fact: '' }, { contentSwitch: ON }),
    '2024년 지점별 매출 표');
  assert.equal(deixis({ seen: '2024년 지점별 매출 표', caption: '지점별 매출 표', fact: '2024년 서울·부산' }, { contentSwitch: ON }),
    '지점별 매출 표, 2024년 서울·부산', '이미 읽히는 칸에 시점이 있으면 그대로 둔다');
  assert.equal(deixis({ seen: '2023년 매출, 2024년 매출', caption: '연도별 매출 표', fact: '' }, { contentSwitch: ON }), '연도별 매출 표');
  assert.equal(deixis({ seen: '2024년 지점별 매출 표', caption: '지점별 매출 표', fact: '' }, { contentSwitch: OFF }), '지점별 매출 표');
  assert.equal(assembleNarration({
    narrationType: 'deixis', subKind: 'complete', contentSwitch: ON,
    rawSlotMap: { seen: '3분기 매출 표, 인원 그래프', caption: '매출 표, 인원 그래프' },
  }).text, '3분기 매출 표, 인원 그래프');
});

test('시점 되살리기(지시): 붙여도 단순형 해설은 7어절 안이다 — 자리가 모자라면 caption 끝 자료 종류 낱말만 떼고, 그래도 모자라면 붙이지 않는다', () => {
  assert.equal(deixis({ seen: '2019년부터 2023년까지 서울 강수량', caption: '부산 대구 두 도시 강수량 막대그래프', fact: '' },
    { contentSwitch: ON }), '2019년부터 2023년까지 부산 대구 두 도시 강수량', '측정량 낱말(강수량)은 남는다');
  assert.equal(deixis({ seen: '2019년부터 2023년까지 서울 강수량', caption: '서울 부산 대구 세 도시 강수량 막대그래프', fact: '' },
    { contentSwitch: ON }), '서울 부산 대구 세 도시 강수량 막대그래프', '자리가 없으면 붙이지 않는다');
  const withFact = deixis({ seen: '2024년 지점별 매출, 세 지점 합계 비교', caption: '서울 부산 대구 지점별 매출 막대그래프', fact: '세 지점 합계 비교' },
    { contentSwitch: ON });
  assert.ok(withFact.split(' ').length <= 7, withFact);
  assert.ok(withFact.startsWith('서울 부산 대구 지점별 매출'), withFact);
  assert.ok(!withFact.includes('2024년'), `자리가 없으면 시점을 붙이지 않는다: ${withFact}`);
});

test('시점 되살리기(수치): source 에 하나뿐인 시점이 해설에 없으면 대상 칸·해석틀 앞에 붙인다', () => {
  assert.equal(claim({ source: '2024년 4분기 매출 120억 → 150억', target: '매출', value: '120억에서 150억', contentSwitch: ON }),
    '2024년 4분기 매출, 120억에서 150억');
  assert.equal(claim({ source: '2024년 4분기 매출 120억 → 150억', target: '매출', value: '120억에서 150억', contentSwitch: OFF }),
    '매출, 120억에서 150억');
  assert.equal(claim({ source: '매출 2023년 120억, 2024년 150억', target: '매출', value: '2023년 120억에서 2024년 150억', contentSwitch: ON }),
    '매출, 2023년 120억에서 2024년 150억');
  const meaning = assembleNarration({
    narrationType: 'interpretation', subKind: 'value_to_meaning', contentSwitch: ON,
    rawSlotMap: { source: '2025년 목표 전환율 73%', value: '73%', frame: '목표 전환율' },
  });
  assert.equal(meaning.text, '73%는 2025년 목표 전환율을 의미');
});

test('프롬프트: 켜면 지시·수치 모두 시점을 지우지 않게 한다(발표자가 말한 시점이어도)', () => {
  const deixisOn = buildGroundingPrompt({ utterance: '여기 보시면', maxChars: 60, subKind: 'simple', contentSwitch: ON });
  assert.match(deixisOn, /시점\(연도·분기·월·주\)이 대상에 적혀 있으면 지우지 않는다/);
  assert.doesNotMatch(buildGroundingPrompt({ utterance: '여기 보시면', maxChars: 60, subKind: 'simple', contentSwitch: OFF }),
    /시점\(연도·분기·월·주\)이 대상에 적혀 있으면/);
  for (const subKind of ['claim_to_value', 'value_to_meaning']) {
    const on = buildInterpretationPrompt({ utterance: '크게 늘었습니다.', subKind, contentSwitch: ON });
    assert.match(on, /시점\(연도·분기·월·주\)은 지우지 않는다/, subKind);
    const off = buildInterpretationPrompt({ utterance: '크게 늘었습니다.', subKind, contentSwitch: OFF });
    assert.doesNotMatch(off, /시점\(연도·분기·월·주\)은 지우지 않는다/, subKind);
  }
});

// 시점 되살리기는 코드가 붙이는 사실이라, 대상 전체의 시점이라고 확신할 수 없으면 붙이지 않는다.
test('시점 되살리기: 근거 칸이 시간 축(월별·분기별·연도별)을 말하면 그 안의 시점은 축의 한 칸일 수 있어 붙이지 않는다', () => {
  assert.equal(deixis({ seen: '월별 방문자 막대그래프 (12월 최고)', caption: '방문자 수 막대그래프' }, { contentSwitch: ON }), '방문자 수 막대그래프');
  assert.equal(deixis({ seen: '연도별 인구 그래프, 2024년 표시', caption: '서울 인구 그래프' }, { contentSwitch: ON }), '서울 인구 그래프');
  assert.equal(deixis({ seen: '분기별 매출 표, 강조 표시된 3분기', caption: '지역별 매출 표' }, { contentSwitch: ON }), '지역별 매출 표');
  assert.equal(claim({ source: '월별 신규 가입자 (12월 강조) 1,200명', target: '신규 가입자', value: '1,200명', contentSwitch: ON }),
    '신규 가입자, 1,200명');
});

test('시점 되살리기: 쉼표·가운뎃점으로 나열한 시점("2023, 2024년", "3, 4분기")은 붙이지 않는다', () => {
  assert.equal(deixis({ seen: '2023, 2024년 월 매출 비교 막대', caption: '월 매출 비교 막대그래프' }, { contentSwitch: ON }), '월 매출 비교 막대그래프');
  assert.equal(claim({ source: '2023, 2024년 신규 가입자 800명 1,200명', target: '신규 가입자 수', value: '800명에서 1,200명', contentSwitch: ON }),
    '신규 가입자 수, 800명에서 1,200명');
  assert.equal(readSingleTimeMark('3, 4분기 실적'), null);
  assert.equal(readSingleTimeMark('1,2분기 매출'), null);
  assert.equal(readSingleTimeMark('2023·2024년 매출 비교'), null);
  assert.equal(readSingleTimeMark('2024년 매출 표, 1,200억'), '2024년', '천 단위 쉼표는 나열이 아니다');
});

test('시점 되살리기: 문서 작성일·출처 연도(작성·출처·발표·갱신·현재 곁)는 자료의 시점이 아니어서 붙이지 않는다', () => {
  assert.equal(deixis({ seen: '서울 인구 지도, 출처 통계청 2024년', caption: '서울 구별 인구 지도' }, { contentSwitch: ON }), '서울 구별 인구 지도');
  assert.equal(deixis({ seen: '2024년 3월 작성, 지역별 매출 막대', caption: '지역별 매출 막대그래프' }, { contentSwitch: ON }), '지역별 매출 막대그래프');
  assert.equal(readSingleTimeMark('2024년 3월 현재 지점별 인원'), null);
  assert.equal(readSingleTimeMark('2024년 지점별 매출, 2025년 1월 갱신'), null);
});

test('시점 되살리기: 되살린 시점은 조립 결과(restoredTimeMark)에 남기고, 되살리지 않았거나 끄면 남기지 않는다', () => {
  const rawSlotMap = { seen: '2024년 지점별 매출 표, 서울 120억', caption: '지점별 매출 표', fact: '' };
  const restored = assembleNarration({ narrationType: 'deixis', subKind: 'simple', rawSlotMap, contentSwitch: ON });
  assert.equal(restored.text, '2024년 지점별 매출 표');
  assert.equal(restored.restoredTimeMark, '2024년');
  const off = assembleNarration({ narrationType: 'deixis', subKind: 'simple', rawSlotMap, contentSwitch: OFF });
  assert.equal(off.text, '지점별 매출 표');
  assert.ok(!('restoredTimeMark' in off));
  const none = assembleNarration({ narrationType: 'deixis', subKind: 'simple', contentSwitch: ON,
    rawSlotMap: { seen: '지점별 매출 표', caption: '지점별 매출 표', fact: '' } });
  assert.ok(!('restoredTimeMark' in none));
});

test('파이프라인: 되살린 시점을 해설 기록과 흐름 창 기록에 남긴다', () => {
  const source = fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');
  assert.match(source, /restoredTimeMark = null,?[\s\S]*?\} = await agent\.generate\(/);
  const recordStart = source.indexOf('kind: RECORD_KIND_MAP.deixis, ts, utterance, caption: text, isGrounded, judgeReason');
  assert.ok(recordStart >= 0);
  assert.match(source.slice(recordStart, source.indexOf('});', recordStart)), /restoredTimeMark/);
  assert.match(source, /시점 되살림="\$\{restoredTimeMark\}"/);
});

test('시점 낱말: 양끝에 단위가 붙은 범위("2019년~2023년", "1월~12월", "3분기~4분기")도 시점으로 본다', () => {
  for (const word of ['2019년~2023년', '2023년-2024년', '1월~12월', '3분기~4분기', 'Q1~Q3', '상반기~하반기', '2019년~2023년까지']) {
    assert.equal(isTimeMarkWord(word), true, word);
  }
  assert.equal(readSingleTimeMark('2019년~2023년 누적 강수량'), '2019년~2023년');
});

test('예산 맞추기: 양끝 단위 범위도 시점이라 먼저 지우지 않는다', () => {
  assert.equal(claim({ target: '2019년~2023년 누적 신규 가입자', value: '서울 1,200명, 부산 800명, 대구 500명', maxWordCount: 8, contentSwitch: ON }),
    '2019년~2023년 신규 가입자, 서울 1,200명, 부산 800명');
  assert.equal(claim({ target: '1월~12월 누적 강수량 합계', value: '서울 1,450mm, 부산 1,520mm, 대구 1,050mm', maxWordCount: 8, contentSwitch: ON }),
    '1월~12월 강수량 합계, 서울 1,450mm, 부산 1,520mm');
  // 읽히는 칸에 이미 범위 시점이 있으면 근거 칸의 다른 시점을 하나 더 붙이지 않는다.
  assert.equal(deixis({ seen: '2024년 서울 인구', caption: '2019년~2023년 서울 인구 그래프' }, { contentSwitch: ON }), '2019년~2023년 서울 인구 그래프');
});

test('시점 되살리기(지시 완전형): caption 을 자르지 않는다 — 자리가 없으면 시점을 붙이지 않는다', () => {
  const caption = '서울 인구 950만, 부산 인구 330만, 대구 인구 240만, 인천 인구 300만';
  const complete = (rawSlotMap, option = {}) => assembleNarration({ narrationType: 'deixis', subKind: 'complete', rawSlotMap, contentSwitch: ON, ...option }).text;
  assert.equal(complete({ seen: '2024년 서울 부산 대구 인천 인구 표', caption }), caption);
  assert.equal(complete({ seen: '2024년 서울 부산 인구 표', caption: '서울 인구 950만, 부산 인구 330만' }), '2024년 서울 인구 950만, 부산 인구 330만');
  // 렌더러 예산(완전형 최대 10어절)도 넘지 않는다.
  assert.equal(complete({ seen: '2024년 인구 표', caption: '서울 인구 950만, 부산 인구 330만, 대구 인구 240만, 인천' }, { maxWordCount: 10 }),
    '서울 인구 950만, 부산 인구 330만, 대구 인구 240만, 인천');
});

test('시점 되살리기(지시 단순형): 자리를 만들려고 측정량 낱말을 지우지 않는다', () => {
  const text = deixis({ seen: '2024년 3분기 수도권 지역별 신규 가입자 수 막대', caption: '수도권 지역별 신규 가입자 수 막대그래프', fact: '서울 경기 인천' },
    { contentSwitch: ON });
  assert.equal(text, '수도권 지역별 신규 가입자 수 막대그래프');
  const price = deixis({ seen: '2024년 서울 강남구 아파트 평균 매매 가격 표, 25개 단지', caption: '서울 강남구 아파트 평균 매매 가격 표', fact: '25개 단지 비교' },
    { contentSwitch: ON });
  assert.ok(price.includes('평균 매매 가격'), price);
  assert.ok(price.split(' ').length <= 7, price);
});

test('시점 되살리기(지시 단순형): 렌더러 예산(maxWordCount)도 넘지 않는다', () => {
  const rawSlotMap = { seen: '2024년 지점별 매출 표', caption: '서울 부산 대구 지점별 매출 표', fact: '' };
  assert.equal(deixis(rawSlotMap, { contentSwitch: ON, maxWordCount: 7 }), '2024년 서울 부산 대구 지점별 매출 표');
  assert.equal(deixis(rawSlotMap, { contentSwitch: ON, maxWordCount: 6 }), '2024년 서울 부산 대구 지점별 매출', '자료 종류 낱말만 떼어 자리를 만든다');
  assert.equal(deixis(rawSlotMap, { contentSwitch: ON, maxWordCount: 5 }), '서울 부산 대구 지점별 매출 표', '그래도 모자라면 붙이지 않는다');
});

test('첫 쌍 다시 조립: 되살린 시점이 대상 칸을 다시 잘라 측정량을 지우지 않는다', () => {
  const first = assembleNarration({
    narrationType: 'interpretation', subKind: 'claim_to_value', hasSecondClaim: true, maxWordCount: 12, contentSwitch: ON,
    rawSlotMap: {
      source: '2024년 3분기 서울 신규 가입자 수 800명 1,200명', target: '서울 신규 가입자 수', value: '800명에서 1,200명',
      target2: '부산 매출', value2: '30억',
    },
  });
  assert.equal(first.text, '2024년 3분기 서울 신규 가입자 수, 800명에서 1,200명. 부산 매출, 30억');
  // main 이 둘째 값이 화면에 없을 때 하는 다시 조립(index.js)과 같은 호출이다.
  const firstPair = assembleNarration({
    narrationType: 'interpretation', subKind: 'claim_to_value', rawSlotMap: { ...first.slotMap, target2: '', value2: '' },
    maxWordCount: 12, contentSwitch: ON,
  });
  assert.equal(firstPair.text, '2024년 3분기 서울 신규 가입자 수, 800명에서 1,200명');
});

test('시점 되살리기(수치): 예산을 맞추느라 대상 칸의 다른 낱말을 밀어내야 하면 붙이지 않는다', () => {
  assert.equal(claim({ source: '2024년 서울 신규 가입자 1,200명 1,500명', target: '서울 신규 가입자', value: '1,200명에서 1,500명',
    maxWordCount: 5, contentSwitch: ON }), '서울 신규 가입자, 1,200명에서 1,500명');
});

test('시점 되살리기(영어): 관사 뒤에 붙인다', () => {
  const english = (narrationType, subKind, rawSlotMap) => assembleNarration({ narrationType, subKind, rawSlotMap, language: 'en', contentSwitch: ON }).text;
  assert.equal(english('deixis', 'simple', { seen: 'Revenue by region, FY24', caption: 'the regional revenue bar chart' }),
    'The FY24 regional revenue bar chart');
  assert.equal(english('interpretation', 'value_to_meaning', { source: 'Valuation growth, FY24', value: '73%', frame: 'the valuation growth rate of Company A' }),
    '73% means the FY24 valuation growth rate of Company A');
});
