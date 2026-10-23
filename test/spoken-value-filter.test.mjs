import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  filterSpokenLines, SPOKEN_FILTER_REASON_MAP,
} = require('../src/main/caption-pipeline/orchestrator/spoken-value-filter.js');

test('줄의 숫자를 받아쓰기에서 이미 말했으면 거른다', () => {
  const result = filterSpokenLines({ lineList: ['매출 42억'], transcript: '올해는 42억 원을 넘겼습니다' });
  assert.deepEqual(result.keptLineList, []);
  assert.equal(result.skipReason, SPOKEN_FILTER_REASON_MAP.spoken);
  assert.equal(result.spokenCount, 1);
});

test('천 단위 쉼표가 달라도 같은 수로 본다', () => {
  const result = filterSpokenLines({ lineList: ['1,234명'], transcript: '참가자는 1234명입니다' });
  assert.deepEqual(result.keptLineList, []);
});

test('다른 수를 말했으면 남긴다', () => {
  const result = filterSpokenLines({ lineList: ['42%'], transcript: '대략 41% 정도' });
  assert.deepEqual(result.keptLineList, ['42%']);
  assert.equal(result.skipReason, null);
});

test('숫자 없는 줄은 받아쓰기에 같은 문장이 있으면 거르고, 다른 문장이면 남긴다', () => {
  const same = filterSpokenLines({ lineList: ['고객 만족이 최우선'], transcript: '자 보시면 고객 만족이 최우선 이라고 적었죠' });
  assert.deepEqual(same.keptLineList, []);
  const other = filterSpokenLines({ lineList: ['물류 자동화 도입'], transcript: '자 보시면 고객 만족이 최우선 이라고 적었죠' });
  assert.deepEqual(other.keptLineList, ['물류 자동화 도입']);
});

test('최근 해설에 같은 값이 있으면 already_narrated 로 거른다', () => {
  const result = filterSpokenLines({
    lineList: ['영업이익 17%'], transcript: '이 부분을 보시면요', narrationTextList: ['영업이익, 17%'],
  });
  assert.deepEqual(result.keptLineList, []);
  assert.equal(result.skipReason, SPOKEN_FILTER_REASON_MAP.alreadyNarrated);
  assert.equal(result.narratedCount, 1);
});

test('한글 수사("사십이 퍼센트")는 숫자와 맞추지 않는다 — 한계를 그대로 둔다', () => {
  const result = filterSpokenLines({ lineList: ['42%'], transcript: '사십이 퍼센트입니다' });
  assert.deepEqual(result.keptLineList, ['42%']);
});

test('남은 줄은 숫자가 있는 줄을 먼저 둔다', () => {
  const result = filterSpokenLines({ lineList: ['신규 지표', '전환율 3.4%', '설명 문구'], transcript: '' });
  assert.deepEqual(result.keptLineList, ['전환율 3.4%', '신규 지표', '설명 문구']);
});
