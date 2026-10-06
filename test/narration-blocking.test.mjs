import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNarrationHistory } = require('../src/main/caption-pipeline/orchestrator/narration-history.js');
const { NARRATION_CLASS_MAP } = require('../src/main/caption-pipeline/contracts/narration-types.js');

const {
  userCommand, pageTransition, speakerIdentity, silenceBased, speechBased, deixis,
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

test('페이지 전환·화자 안내 직후의 발화 기반·지시 해설은 그 해설의 간격 동안 막힌다', () => {
  for (const blockerClass of [pageTransition, speakerIdentity]) {
    const history = createHistoryWith([{ text: '슬라이드 2: 분기별 매출', narrationClass: blockerClass, ts: 0 }]);
    for (const narrationClass of [speechBased, deixis]) {
      const rate = history.findRateLimited({ narrationClass, ts: 10000, hasPointingRegion: true });
      assert.equal(rate.isRateLimited, true, `${blockerClass} → ${narrationClass}`);
      assert.equal(rate.blockedByClass, blockerClass);
      assert.equal(history.findRateLimited({ narrationClass, ts: 12000, hasPointingRegion: true }).isRateLimited, false);
    }
  }
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

test('무발화 해설은 페이지 전환·화자 안내 뒤 12초 동안만 막힌다', () => {
  for (const blockerClass of [pageTransition, speakerIdentity]) {
    const history = createHistoryWith([{ text: '김 님이 말합니다', narrationClass: blockerClass, ts: 0 }]);
    const rate = history.findRateLimited({ narrationClass: silenceBased, ts: 11999 });
    assert.equal(rate.isRateLimited, true, blockerClass);
    assert.equal(rate.blockedByClass, blockerClass);
    assert.equal(rate.minIntervalMs, 12000);
    assert.equal(history.findRateLimited({ narrationClass: silenceBased, ts: 12000 }).isRateLimited, false);
  }
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
  const history = createHistoryWith([{ text: '슬라이드 2: 분기별 매출', narrationClass: pageTransition, ts: 0 }]);
  assert.equal(history.findRateLimited({ narrationClass: deixis, ts: 1000 }).isRateLimited, true);
  history.forget({ ts: 0, text: '슬라이드 2: 분기별 매출' });
  assert.equal(history.findRateLimited({ narrationClass: deixis, ts: 1000 }).isRateLimited, false);
});
