import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNarrationHistory } = require('../src/main/caption-pipeline/orchestrator/narration-history.js');
const { NARRATION_CLASS_MAP } = require('../src/main/caption-pipeline/contracts/narration-types.js');

const {
  userCommand, pageTransition, speakerIdentity, silenceBased, speechBased, deixis, screenChange,
} = NARRATION_CLASS_MAP;

function createHistoryWith(entryList) {
  const history = createNarrationHistory();
  entryList.forEach(({ text, narrationClass, ts, source = 'deixis' }) => {
    history.remember({ text, source, ts, narrationClass });
  });
  return history;
}

test('먼저 낸 지시 해설은 뒤에 온 발화 기반 해설을 막지 않는다', () => {
  const history = createHistoryWith([{ text: '왼쪽 위 매출 추이 표', narrationClass: deixis, ts: 0 }]);
  const rate = history.findRateLimited({ narrationClass: speechBased, ts: 5000 });
  assert.equal(rate.isRateLimited, false);
  assert.equal(rate.blockedByClass, null);
});

test('먼저 낸 발화 기반 해설은 간격 안의 지시 해설을 막고, 막은 분류·간격을 돌려준다', () => {
  const history = createHistoryWith([{ text: '73%는 작년 대비 성장률', narrationClass: speechBased, ts: 0, source: 'interpretation' }]);
  const rate = history.findRateLimited({ narrationClass: deixis, ts: 5000 });
  assert.equal(rate.isRateLimited, true);
  assert.equal(rate.blockedByClass, speechBased);
  assert.equal(rate.sinceMs, 5000);
  assert.equal(rate.minIntervalMs, 18000);
});

test('지시 해설끼리는 지금처럼 가리킨 곳이 있으면 12초, 발화만 있으면 18초 간격으로 막는다', () => {
  const history = createHistoryWith([{ text: '파란 막대그래프', narrationClass: deixis, ts: 0 }]);
  assert.equal(history.findRateLimited({ narrationClass: deixis, ts: 11999, hasPointingRegion: true }).isRateLimited, true);
  assert.equal(history.findRateLimited({ narrationClass: deixis, ts: 12000, hasPointingRegion: true }).isRateLimited, false);
  assert.equal(history.findRateLimited({ narrationClass: deixis, ts: 17999 }).isRateLimited, true);
  assert.equal(history.findRateLimited({ narrationClass: deixis, ts: 18000 }).isRateLimited, false);
});

test('페이지 전환·화자 안내 직후의 발화 기반·지시 해설은 막히지 않는다', () => {
  for (const blockerClass of [pageTransition, speakerIdentity]) {
    const history = createHistoryWith([{ text: '슬라이드 2: 분기별 매출', narrationClass: blockerClass, ts: 0 }]);
    for (const narrationClass of [speechBased, deixis]) {
      for (const hasPointingRegion of [true, false]) {
        const rate = history.findRateLimited({ narrationClass, ts: 3000, hasPointingRegion });
        assert.equal(rate.isRateLimited, false, `${blockerClass} → ${narrationClass}`);
        assert.equal(rate.blockedByClass, null);
      }
    }
  }
});

test('사진 단독 전환의 반응 묘사는 페이지 전환 분류라 발화 기반·지시 해설은 막지 않고 무발화 해설만 막는다', () => {
  const history = createHistoryWith([{
    text: '소나무보다 4배 큰 불상', narrationClass: pageTransition, ts: 0, source: 'visual_description',
  }]);
  assert.equal(history.findRateLimited({ narrationClass: speechBased, ts: 3000 }).isRateLimited, false);
  assert.equal(history.findRateLimited({ narrationClass: deixis, ts: 3000 }).isRateLimited, false);
  const rate = history.findRateLimited({ narrationClass: silenceBased, ts: 3000 });
  assert.equal(rate.isRateLimited, true);
  assert.equal(rate.blockedByClass, pageTransition);
});

test('무발화 해설 직후의 발화 기반·지시 해설은 막힌다', () => {
  const history = createHistoryWith([{
    text: '이미지 제시, 야윈 어린아이 사진', narrationClass: silenceBased, ts: 0, source: 'visual_description',
  }]);
  for (const narrationClass of [speechBased, deixis]) {
    const rate = history.findRateLimited({ narrationClass, ts: 9000 });
    assert.equal(rate.isRateLimited, true, narrationClass);
    assert.equal(rate.blockedByClass, silenceBased);
  }
});

test('무발화 해설은 페이지 전환 고지 뒤 12초 동안만 막힌다', () => {
  const history = createHistoryWith([{ text: '슬라이드 2: 분기별 매출', narrationClass: pageTransition, ts: 0 }]);
  const rate = history.findRateLimited({ narrationClass: silenceBased, ts: 11999 });
  assert.equal(rate.isRateLimited, true);
  assert.equal(rate.blockedByClass, pageTransition);
  assert.equal(rate.minIntervalMs, 12000);
  assert.equal(history.findRateLimited({ narrationClass: silenceBased, ts: 12000 }).isRateLimited, false);
});

test('무발화 해설은 화자 안내에 막히지 않는다', () => {
  const history = createHistoryWith([{ text: '김 님이 말합니다', narrationClass: speakerIdentity, ts: 0 }]);
  assert.equal(history.findRateLimited({ narrationClass: silenceBased, ts: 1000 }).isRateLimited, false);
});

test('무발화 해설은 발화 기반·지시 해설에 막히지 않는다', () => {
  const history = createHistoryWith([
    { text: '73%는 작년 대비 성장률', narrationClass: speechBased, ts: 0, source: 'interpretation' },
    { text: '파란 막대그래프', narrationClass: deixis, ts: 1000 },
  ]);
  assert.equal(history.findRateLimited({ narrationClass: silenceBased, ts: 2000 }).isRateLimited, false);
});

test('질문 답은 어느 자동 해설도 막지 않는다', () => {
  const history = createHistoryWith([{ text: '지금 화면은 매출 보고서입니다', narrationClass: userCommand, ts: 0, source: 'user_command' }]);
  for (const narrationClass of [silenceBased, speechBased, deixis]) {
    assert.equal(history.findRateLimited({ narrationClass, ts: 1000 }).isRateLimited, false, narrationClass);
  }
});

test('질문 답·페이지 전환·화자 안내는 간격 검사로 막히지 않는다', () => {
  const history = createHistoryWith([
    { text: '슬라이드 2: 분기별 매출', narrationClass: pageTransition, ts: 0 },
    { text: '김 님이 말합니다', narrationClass: speakerIdentity, ts: 500 },
    { text: '파란 막대그래프', narrationClass: deixis, ts: 1000 },
  ]);
  for (const narrationClass of [userCommand, pageTransition, speakerIdentity]) {
    const rate = history.findRateLimited({ narrationClass, ts: 1500 });
    assert.equal(rate.isRateLimited, false, narrationClass);
    assert.equal(rate.blockedByClass, null);
  }
});

test('뒤에 낸 낮은 순위 해설이 아니라 막을 수 있는 분류 중 가장 최근 해설을 기준으로 잰다', () => {
  const history = createHistoryWith([
    { text: '슬라이드 2: 분기별 매출', narrationClass: pageTransition, ts: 0 },
    { text: '파란 막대그래프', narrationClass: deixis, ts: 10000 },
  ]);
  const rate = history.findRateLimited({ narrationClass: silenceBased, ts: 11000 });
  assert.equal(rate.isRateLimited, true);
  assert.equal(rate.blockedByClass, pageTransition);
  assert.equal(rate.sinceMs, 11000);
});

test('분류 없이 기억한 해설은 지시로 친다', () => {
  const history = createNarrationHistory();
  history.remember({ text: '파란 막대그래프', source: 'deixis', ts: 0 });
  assert.deepEqual(history.getEntryList(), [{ text: '파란 막대그래프', source: 'deixis', ts: 0, narrationClass: deixis }]);
  assert.equal(history.findRateLimited({ narrationClass: deixis, ts: 1000 }).blockedByClass, deixis);
  assert.equal(history.findRateLimited({ narrationClass: speechBased, ts: 1000 }).isRateLimited, false);
});

test('분류 없이 들어온 해설은 지시 규칙으로 검사한다', () => {
  const history = createHistoryWith([{ text: '파란 막대그래프', narrationClass: deixis, ts: 0 }]);
  assert.equal(history.findRateLimited({ ts: 1000 }).isRateLimited, true);
});

test('막을 해설이 없으면 막지 않고 간격은 무한대다', () => {
  const rate = createNarrationHistory().findRateLimited({ narrationClass: deixis, ts: 1000 });
  assert.equal(rate.isRateLimited, false);
  assert.equal(rate.sinceMs, Infinity);
  assert.equal(rate.blockedByClass, null);
});

test('렌더러가 버려 지운 해설은 다음 해설을 막지 않는다', () => {
  const history = createHistoryWith([{ text: '73%는 작년 대비 성장률', narrationClass: speechBased, ts: 0, source: 'interpretation' }]);
  assert.equal(history.findRateLimited({ narrationClass: deixis, ts: 1000 }).isRateLimited, true);
  history.forget({ ts: 0, text: '73%는 작년 대비 성장률' });
  assert.equal(history.findRateLimited({ narrationClass: deixis, ts: 1000 }).isRateLimited, false);
});

test('화면 변화 해설끼리는 20초 간격으로 막는다', () => {
  const history = createHistoryWith([{ text: '새로 표시, 3분기 매출 42억 원', narrationClass: screenChange, ts: 0, source: 'screen_change' }]);
  const rate = history.findRateLimited({ narrationClass: screenChange, ts: 19999 });
  assert.equal(rate.isRateLimited, true);
  assert.equal(rate.minIntervalMs, 20000);
  assert.equal(history.findRateLimited({ narrationClass: screenChange, ts: 20000 }).isRateLimited, false);
});

test('화면 변화 해설 간격은 설정 값으로 바꿀 수 있다', () => {
  const history = createNarrationHistory({ minIntervalMsByClassMap: { [screenChange]: 30000 } });
  history.remember({ text: '새로 표시, 정답 3번', source: 'screen_change', ts: 0, narrationClass: screenChange });
  assert.equal(history.findRateLimited({ narrationClass: screenChange, ts: 29999 }).isRateLimited, true);
  assert.equal(history.findRateLimited({ narrationClass: screenChange, ts: 30000 }).isRateLimited, false);
  history.remember({ text: '파란 막대그래프', source: 'deixis', ts: 40000, narrationClass: deixis });
  assert.equal(history.findRateLimited({ narrationClass: deixis, ts: 50000 }).minIntervalMs, 18000);
});

test('화면 변화 해설 뒤 12초는 무발화 해설을 막는다', () => {
  const history = createHistoryWith([{ text: '새로 표시, 정답 3번', narrationClass: screenChange, ts: 0, source: 'screen_change' }]);
  const rate = history.findRateLimited({ narrationClass: silenceBased, ts: 11999 });
  assert.equal(rate.isRateLimited, true);
  assert.equal(rate.blockedByClass, screenChange);
  assert.equal(history.findRateLimited({ narrationClass: silenceBased, ts: 12000 }).isRateLimited, false);
});

test('화면 변화 해설은 발화 기반·지시 해설을 막지 않고, 그것들에 막히지도 않는다', () => {
  const changed = createHistoryWith([{ text: '새로 표시, 정답 3번', narrationClass: screenChange, ts: 0, source: 'screen_change' }]);
  for (const narrationClass of [speechBased, deixis]) {
    assert.equal(changed.findRateLimited({ narrationClass, ts: 1000 }).isRateLimited, false, narrationClass);
  }
  const spoken = createHistoryWith([
    { text: '73%는 작년 대비 성장률', narrationClass: speechBased, ts: 0, source: 'interpretation' },
    { text: '파란 막대그래프', narrationClass: deixis, ts: 500 },
  ]);
  assert.equal(spoken.findRateLimited({ narrationClass: screenChange, ts: 1000 }).isRateLimited, false);
});

test('화면 변화 해설은 같은 대상이라도 값이 다르면 중복이 아니고, 같은 값이면 중복이다', () => {
  const history = createNarrationHistory();
  history.remember({
    text: '새로 표시, 3분기 매출 42억 원', source: 'screen_change', ts: 0, narrationClass: screenChange,
    slotMap: { target: '3분기 매출', value: '42억 원' }, slideLabel: '2',
  });
  const changedValue = history.findDuplicate({
    text: '새로 표시, 3분기 매출 45억 원', source: 'screen_change', slotMap: { target: '3분기 매출', value: '45억 원' }, slideLabel: '2',
  });
  assert.equal(changedValue.isDuplicate, false);
  const sameValue = history.findDuplicate({
    text: '새로 표시, 3분기 매출 42억 원', source: 'screen_change', slotMap: { target: '3분기 매출', value: '42억 원' }, slideLabel: '2',
  });
  assert.equal(sameValue.isDuplicate, true);
  // 다른 해설이 이미 같은 값을 말했으면 화면 변화 해설도 중복으로 막는다.
  history.remember({
    text: '영업이익, 17%', source: 'interpretation', ts: 1000, narrationClass: speechBased,
    slotMap: { target: '영업이익', value: '17%' }, slideLabel: '2',
  });
  const spokenValue = history.findDuplicate({
    text: '새로 표시, 영업이익 17%', source: 'screen_change', slotMap: { target: '영업이익', value: '17%' }, slideLabel: '2',
  });
  assert.equal(spokenValue.isDuplicate, true);
});

test('같은 대상 규칙은 다른 해설에서는 지금처럼 값과 상관없이 막는다', () => {
  const history = createNarrationHistory();
  history.remember({
    text: '3분기 매출, 42억 원', source: 'interpretation', ts: 0, narrationClass: speechBased,
    slotMap: { target: '3분기 매출', value: '42억 원' }, slideLabel: '2',
  });
  const result = history.findDuplicate({
    text: '3분기 매출 45억 원으로 늘어', source: 'interpretation', slotMap: { target: '3분기 매출', value: '45억 원' }, slideLabel: '2',
  });
  assert.equal(result.isDuplicate, true);
});

test('화면 변화 강조 해설은 다른 항목이 강조되면 중복이 아니고, 같은 항목이면 중복이다', () => {
  const history = createNarrationHistory();
  history.remember({
    text: '강조 표시, 보기 3번', source: 'screen_change', ts: 0, narrationClass: screenChange,
    slotMap: { target: '보기 3번' }, slideLabel: '4',
  });
  assert.equal(history.findDuplicate({
    text: '강조 표시, 보기 4번', source: 'screen_change', slotMap: { target: '보기 4번' }, slideLabel: '4',
  }).isDuplicate, false);
  assert.equal(history.findDuplicate({
    text: '강조 표시, 보기 3번', source: 'screen_change', slotMap: { target: '보기 3번' }, slideLabel: '4',
  }).isDuplicate, true);
});
