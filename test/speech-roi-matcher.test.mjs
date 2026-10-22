import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeLabelText, matchTermInLine, selectRoiTarget, jamoSimilarity, MATCH_KIND_MAP, ROI_SELECT_STATUS_MAP,
  MIN_TARGET_SCORE, LOW_LINE_SCORE, LOW_LINE_SCORE_FACTOR,
} = require('../src/main/caption-pipeline/orchestrator/speech-roi/label-matcher.js');
const {
  ALIAS_GROUP_LIST, LETTER_NAME_MAP, readAcronymReadingList,
} = require('../src/main/caption-pipeline/orchestrator/speech-roi/label-alias.js');

const word = (text, extra = {}) => ({ text, norm: normalizeLabelText(text), kind: 'word', weight: 1, source: 'utterance', isNearAnchor: false, ...extra });
const number = (text, extra = {}) => word(text, { kind: 'number', ...extra });
const acronym = (text, extra = {}) => word(text, { kind: 'acronym', ...extra });
const match = (term, text) => matchTermInLine({ term, line: { text } });

test('정규화: 띄어쓰기·문장부호·전각·자릿점·퍼센트/프로를 같게 만든다', () => {
  assert.equal(normalizeLabelText('매출 액'), normalizeLabelText('매출액'));
  assert.equal(normalizeLabelText('1,234'), '1234');
  assert.equal(normalizeLabelText('ＡＩ'), 'ai');
  assert.equal(normalizeLabelText('（매출）·현황!'), '매출현황');
  assert.equal(normalizeLabelText('3.5%'), '3.5%');
  assert.equal(normalizeLabelText('끝.'), '끝');
  assert.equal(normalizeLabelText('35퍼센트'), '35%');
  assert.equal(normalizeLabelText('30프로'), '30%');
  assert.equal(normalizeLabelText('프로젝트'), '프로젝트');
});

test('맞추기: 정확 1.0 · 포함 0.85(2음절이 5음절 넘는 낱말 안이면 0.7) · 거꾸로 포함 0.7', () => {
  assert.deepEqual(
    { kind: match(word('매출액'), '분기별 매출액 추이').kind, score: match(word('매출액'), '분기별 매출액 추이').score },
    { kind: MATCH_KIND_MAP.exact, score: 1 },
  );
  assert.equal(match(word('매출액'), '분기별 매출액은 182억').kind, MATCH_KIND_MAP.exact, '줄 낱말의 조사를 떼고 견준다');
  const contained = match(word('매출액'), '총매출액 182억');
  assert.equal(contained.kind, MATCH_KIND_MAP.contains);
  assert.equal(contained.score, 0.85);
  assert.equal(match(word('서울'), '서울시 인구').score, 0.85);
  assert.equal(match(word('서울'), '서울특별시청사 위치').score, 0.7);
  assert.equal(match(word('매출액'), '매출 액 182억').kind, MATCH_KIND_MAP.contains, '띄어쓰기 차이');
  const reverse = match(word('서울시'), '서울 인구 942만');
  assert.equal(reverse.kind, MATCH_KIND_MAP.reverseContains);
  assert.equal(reverse.score, 0.7);
  assert.equal(match(word('서울특별시'), '서울 인구'), null, '화면 낱말이 발화 말의 60% 미만');
  assert.equal(match(word('서울'), '도서 울산 지점'), null, '낱말 중간에서 시작해 어절을 건너는 맞춤은 없다');
});

test('맞추기: 맞은 글자 범위(charStart·charEnd)는 원래 줄 글자 기준이다', () => {
  const found = match(word('매출액'), '2023년 총 매출액: 182억');
  assert.equal('2023년 총 매출액: 182억'.slice(found.charStart, found.charEnd), '매출액');
  const spaced = match(word('매출액'), '총 매출 액 182억');
  assert.equal('총 매출 액 182억'.slice(spaced.charStart, spaced.charEnd), '매출 액');
});

test('맞추기: 자모 유사는 3음절 이상만(OCR·받아쓰기 오독) 0.6', () => {
  const fuzzy = match(word('매출액'), '매츨액 182억');
  assert.equal(fuzzy.kind, MATCH_KIND_MAP.jamo);
  assert.equal(fuzzy.score, 0.6);
  assert.equal(fuzzy.isFuzzy, true);
  assert.equal(match(word('매출'), '매츨 182억'), null);
  assert.ok(jamoSimilarity('매출액', '매츨액') >= 0.8);
  assert.ok(jamoSimilarity('매출액', '영업익') < 0.8);
});

test('맞추기: 숫자는 경계까지 같아야 하고(79 ≠ 179·79.5) 단위가 같으면 0.9, 맨숫자는 자릿수로 0.75·0.5', () => {
  assert.equal(match(number('79개'), 'RSU 179개 설치'), null);
  assert.equal(match(number('79개'), 'RSU 79.5개 설치'), null);
  const unitMatch = match(number('79개'), 'RSU 79개 설치');
  assert.equal(unitMatch.kind, MATCH_KIND_MAP.number);
  assert.equal(unitMatch.score, 0.9);
  assert.equal('RSU 79개 설치'.slice(unitMatch.charStart, unitMatch.charEnd), '79개');
  const twoDigit = match(number('79개'), 'RSU 79 설치');
  assert.equal(twoDigit.score, 0.5);
  assert.equal(twoDigit.isTieBreakOnly, true);
  assert.equal(match(number('2024년'), '2024 매출').score, 0.75);
  assert.equal(match(number('1,234억'), '1234억 원').score, 0.9);
  assert.equal(match(number('35퍼센트'), '점유율 35%').score, 0.9);
  assert.equal(match(number('35%'), '점유율 35 퍼센트').score, 0.9);
  assert.equal(match(number('1분기'), '1분기 실적').score, 0.9);
  assert.equal(match(number('1분기'), '11분기 실적'), null);
  assert.equal(match(number('1분기'), '1월 실적'), null, '한 자리 수는 단위까지 같아야 맞는다');
  assert.equal(match(number('2,318'), '방문 2,318명').score, 0.75);
});

test('맞추기: "24년"은 줄의 2024·\'24 와 맞는다(0.75)', () => {
  const full = match(number('24년'), '2024 매출');
  assert.equal(full.kind, MATCH_KIND_MAP.year);
  assert.equal(full.score, 0.75);
  assert.equal(match(number('24년'), "'24 실적").kind, MATCH_KIND_MAP.year);
  assert.equal(match(number('24년'), '1924 기록'), null);
});

test('맞추기: 영문은 낱말 경계로만 맞춘다("AI"가 "MAIN"에 맞지 않음)', () => {
  assert.equal(match(acronym('AI'), 'MAIN 메뉴'), null);
  assert.equal(match(acronym('AI'), 'AI 투자').score, 1);
  assert.equal(match(acronym('AI'), '생성형 AI가 늘었다').kind, MATCH_KIND_MAP.latin);
  assert.equal(match(word('growth', { norm: 'growth' }), 'Revenue Growth 12%').kind, MATCH_KIND_MAP.latin);
});

test('맞추기: 영문 약어를 알파벳 이름으로 읽어 한글과 맞춘다(GDP ↔ 지디피) 0.8', () => {
  assert.equal(Object.keys(LETTER_NAME_MAP).length, 26);
  assert.ok(readAcronymReadingList('GDP').includes('지디피'));
  assert.ok(readAcronymReadingList('AI').includes('에이아이'));
  const spoken = match(acronym('GDP'), '지디피 성장률');
  assert.equal(spoken.kind, MATCH_KIND_MAP.acronymReading);
  assert.equal(spoken.score, 0.8);
  const written = match(word('지디피'), '한국 GDP 성장률');
  assert.equal(written.kind, MATCH_KIND_MAP.acronymReading);
  assert.equal('한국 GDP 성장률'.slice(written.charStart, written.charEnd), 'GDP');
});

test('맞추기: 작은 사전의 같은 묶음은 0.8, 영문 묶음 말도 낱말 경계로만 맞춘다', () => {
  const revenue = match(word('매출'), 'Revenue 2024');
  assert.equal(revenue.kind, MATCH_KIND_MAP.alias);
  assert.equal(revenue.score, 0.8);
  assert.equal(match(number('1분기'), 'Q1 실적').kind, MATCH_KIND_MAP.alias);
  assert.equal(match(word('작년'), '전년 대비 12%').kind, MATCH_KIND_MAP.alias);
  assert.equal(match(word('미국'), 'FOCUS AREA'), null);
  assert.equal(match(word('미국'), 'US 시장').kind, MATCH_KIND_MAP.alias);
});

test('사전: 한 말이 두 묶음에 들지 않고, 묶음마다 말이 둘 이상이다', () => {
  const seenGroupByNormMap = new Map();
  ALIAS_GROUP_LIST.forEach((group, groupIndex) => {
    assert.ok(group.length >= 2, group.join(','));
    for (const member of group) {
      const norm = normalizeLabelText(member);
      assert.ok(norm, member);
      const seenIndex = seenGroupByNormMap.get(norm);
      assert.ok(seenIndex === undefined || seenIndex === groupIndex, `"${member}" 가 두 묶음에 있다`);
      seenGroupByNormMap.set(norm, groupIndex);
    }
  });
  assert.ok(ALIAS_GROUP_LIST.length >= 40 && ALIAS_GROUP_LIST.length <= 80, `묶음 ${ALIAS_GROUP_LIST.length}개`);
});

// 고르기 — 줄 상자는 공유 화면 칸 기준 0~1 비율이다.
const line = (text, rect, score = 0.95) => ({ text, score, rect });
const row = (text, y, x = 0.1, w = 0.25, h = 0.04, score = 0.95) => line(text, { x, y, w, h }, score);

test('고르기: 맞는 줄이 4줄 이상 흩어져 있으면 그 낱말을 버린다', () => {
  const lineList = [row('서울 12', 0.1, 0.05), row('서울 13', 0.3, 0.7), row('서울 14', 0.5, 0.05), row('서울 15', 0.7, 0.7), row('서울 16', 0.9, 0.4)];
  const result = selectRoiTarget({ termList: [word('서울')], lineList });
  assert.equal(result.status, ROI_SELECT_STATUS_MAP.noMatch);
});

test('고르기: 4줄 이상이 한데 모여 있으면(표의 한 열) 묶음 상자 하나를 후보로 쓴다', () => {
  const lineList = [0.3, 0.35, 0.4, 0.45, 0.5].map((y, index) => row(`서울 ${index + 10}`, y, 0.1, 0.15, 0.04));
  lineList.push(row('부산 지점 현황', 0.8, 0.6));
  const result = selectRoiTarget({ termList: [word('서울')], lineList });
  assert.equal(result.status, ROI_SELECT_STATUS_MAP.selected);
  assert.equal(result.targetList.length, 1);
  assert.equal(result.targetList[0].isCluster, true);
  const { rect } = result.targetList[0];
  assert.ok(Math.abs(rect.y - 0.3) < 1e-9 && Math.abs(rect.y + rect.h - 0.54) < 1e-9);
});

test('고르기: 맞는 줄 수로 변별력을 준다(1줄 ×1.0, 2줄 ×0.8, 3줄 ×0.6)', () => {
  const single = selectRoiTarget({ termList: [word('서울')], lineList: [row('서울 지점', 0.5)] });
  assert.equal(single.targetList[0].score, 1);
  const triple = selectRoiTarget({
    termList: [word('서울')], lineList: [row('서울 지점', 0.2), row('서울 본사', 0.5), row('서울 공장', 0.8)],
  });
  assert.ok(Math.abs(triple.targetList[0].score - 0.6) < 1e-9);
});

test('고르기: 낱말 둘이 함께 든 줄이 이긴다', () => {
  const lineList = [row('서울 12%', 0.3), row('부산 2024', 0.5, 0.6), row('서울 2024 35%', 0.7, 0.3)];
  const result = selectRoiTarget({ termList: [word('서울'), number('2024년')], lineList });
  assert.equal(result.status, ROI_SELECT_STATUS_MAP.selected);
  assert.equal(result.targetList[0].line.text, '서울 2024 35%');
  assert.equal(result.ambiguity.isAmbiguous, false);
});

test('고르기: 제목만 맞으면 확대하지 않고, 다른 줄이 맞으면 제목을 낮춘다', () => {
  const title = line('서울시 인구 현황', { x: 0.1, y: 0.05, w: 0.6, h: 0.08 });
  const bodyList = [row('강남 54만', 0.4), row('송파 66만', 0.5), row('노원 50만', 0.6)];
  const titleOnly = selectRoiTarget({ termList: [word('서울시')], lineList: [title, ...bodyList] });
  assert.equal(titleOnly.status, ROI_SELECT_STATUS_MAP.titleOnly);
  const withBody = selectRoiTarget({ termList: [word('서울시')], lineList: [title, ...bodyList, row('서울시 합계 942만', 0.75, 0.5)] });
  assert.equal(withBody.status, ROI_SELECT_STATUS_MAP.selected);
  assert.equal(withBody.targetList[0].line.text, '서울시 합계 942만');
  assert.equal(withBody.targetList.length, 1, '낮춘 제목은 2등이 되지 못한다');
});

test('고르기: 멀리 떨어진 비슷한 점수의 두 줄은 애매(합칠지는 상자 크기로 정한다), 가까우면 함께 쓴다', () => {
  const far = selectRoiTarget({ termList: [word('매출')], lineList: [row('매출 182억', 0.1, 0.05), row('매출 95억', 0.85, 0.7)] });
  assert.equal(far.status, ROI_SELECT_STATUS_MAP.selected);
  assert.equal(far.ambiguity.isAmbiguous, true);
  assert.equal(far.targetList.length, 2);
  const near = selectRoiTarget({ termList: [word('매출')], lineList: [row('매출 182억', 0.4, 0.1), row('매출 95억', 0.46, 0.1)] });
  assert.equal(near.ambiguity.isAmbiguous, false);
  assert.equal(near.targetList.length, 2);
});

test('고르기: 줄 점수가 낮은 OCR 줄은 ×0.7 이라 같은 글자의 믿을 줄이 이긴다', () => {
  assert.equal(LOW_LINE_SCORE, 0.6);
  assert.equal(LOW_LINE_SCORE_FACTOR, 0.7);
  const result = selectRoiTarget({
    termList: [word('매출')],
    lineList: [row('매출 182억', 0.1, 0.05, 0.25, 0.04, 0.5), row('매출 95억', 0.85, 0.7, 0.25, 0.04, 0.95)],
  });
  assert.equal(result.targetList[0].line.text, '매출 95억');
  assert.equal(result.ambiguity.isAmbiguous, false);
});

test('고르기: 자모 유사는 맞는 줄이 하나일 때만, 두 자리 맨숫자 혼자서는 고르지 않는다, 최저 점수 0.6', () => {
  assert.equal(MIN_TARGET_SCORE, 0.6);
  const oneFuzzy = selectRoiTarget({ termList: [word('매출액')], lineList: [row('매츨액 182억', 0.3), row('영업이익 20억', 0.6)] });
  assert.equal(oneFuzzy.status, ROI_SELECT_STATUS_MAP.selected);
  assert.equal(oneFuzzy.targetList[0].match.kind, MATCH_KIND_MAP.jamo);
  const twoFuzzy = selectRoiTarget({ termList: [word('매출액')], lineList: [row('매츨액 182억', 0.3), row('매춣액 20억', 0.6)] });
  assert.equal(twoFuzzy.status, ROI_SELECT_STATUS_MAP.noMatch);
  const bareNumber = selectRoiTarget({ termList: [number('35')], lineList: [row('점유율 35', 0.3)] });
  assert.equal(bareNumber.status, ROI_SELECT_STATUS_MAP.noMatch);
  const beforeOnly = selectRoiTarget({ termList: [word('서울', { weight: 0.6, source: 'before' })], lineList: [row('서울시청 위치', 0.3)] });
  assert.equal(beforeOnly.status, ROI_SELECT_STATUS_MAP.noMatch);
  assert.equal(selectRoiTarget({ termList: [], lineList: [row('서울', 0.3)] }).status, ROI_SELECT_STATUS_MAP.noTerms);
});

test('고르기: 대상이 둘이면(완전형·둘째 주장) 서로 다른 낱말로 맞은 줄 둘을 고른다', () => {
  const lineList = [row('서울 182억', 0.2), row('부산 95억', 0.7, 0.6), row('대구 40억', 0.45, 0.3)];
  const result = selectRoiTarget({ termList: [word('서울'), word('부산')], lineList, maxTargetCount: 2 });
  assert.deepEqual(result.targetList.map((target) => target.line.text), ['서울 182억', '부산 95억']);
  assert.equal(result.targetList[1].role, 'second');
  assert.equal(result.ambiguity.isAmbiguous, false);
  const single = selectRoiTarget({ termList: [word('서울'), word('부산')], lineList, maxTargetCount: 1 });
  assert.equal(single.targetList[1].role, 'peer', '대상이 하나인데 두 줄이 비슷하면 애매로 본다');
  assert.equal(single.ambiguity.isAmbiguous, true);
});
