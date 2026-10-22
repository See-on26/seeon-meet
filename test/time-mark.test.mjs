import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readContentSwitch, CONTENT_SWITCH_ENV_NAME_MAP } = require('../src/main/caption-pipeline/agents/shared/content-switch.js');
const { isTimeMarkWord, readSingleTimeMark } = require('../src/main/caption-pipeline/agents/shared/time-mark.js');
const { assembleNarration } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { buildGroundingPrompt } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');

// 시점 표기 지키기: 연도·분기·월·주 같은 시점이 대상 칸·해설에서 지워지지 않게 한다.
// 예산 맞추기가 대상 칸 앞쪽 꾸밈말부터 빼면서 맨 앞의 시점이 가장 먼저 사라졌고, 모델도 칸 어절 수를 맞추느라 시점을 뺐다.
const ON = { isTimeMarkEnabled: true };
const OFF = { isTimeMarkEnabled: false };

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
