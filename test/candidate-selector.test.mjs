import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectGeneratableCandidate } = require('../src/main/caption-pipeline/orchestrator/candidate-selector.js');
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');
const { createNarrationHistory } = require('../src/main/caption-pipeline/orchestrator/narration-history.js');

const scale = { type: 'visual_description', subKind: 'scale', anchor: '훨씬 큽니다', ts: 1 };
const deixis = { type: 'deixis', subKind: 'simple', anchor: '이거', ts: 1 };
const valueToMeaning = { type: 'interpretation', subKind: 'value_to_meaning', anchor: '30%', ts: 1 };

test('척도 보류(기본)면 척도 후보를 빼고, 지시 후보가 흡수되지 않고 남는다', () => {
  const { selected, excludedList } = selectGeneratableCandidate({ candidateList: [scale, deixis] });
  assert.equal(selected.type, 'deixis');
  assert.deepEqual(excludedList, [scale]);
});

test('척도만 있으면 아무것도 고르지 않는다', () => {
  const { selected, excludedList } = selectGeneratableCandidate({ candidateList: [scale] });
  assert.equal(selected, null);
  assert.equal(excludedList.length, 1);
});

test('척도 플래그를 켜면 기존 동작(척도가 지시를 흡수)', () => {
  const { selected, excludedList } = selectGeneratableCandidate({ candidateList: [scale, deixis], isScaleEnabled: true });
  assert.equal(selected.type, 'visual_description');
  assert.deepEqual(selected.mergedAnchorList, ['이거']);
  assert.equal(excludedList.length, 0);
});

test('해석 후보는 지시를 흡수한다 (기존 규칙 유지)', () => {
  const { selected } = selectGeneratableCandidate({ candidateList: [deixis, valueToMeaning] });
  assert.equal(selected.type, 'interpretation');
  assert.deepEqual(selected.mergedAnchorList, ['이거']);
});

test('생성 대상이 아닌 유형은 무시한다', () => {
  const { selected } = selectGeneratableCandidate({ candidateList: [{ type: 'speaker_identity', ts: 1 }] });
  assert.equal(selected, null);
});

test('설정: 척도 플래그 기본 꺼짐, "true" 일 때만 켜짐', () => {
  assert.equal(readPipelineConfig({}).isScaleEnabled, false);
  assert.equal(readPipelineConfig({ SEEON_ROUTER_SCALE_ENABLED: 'true' }).isScaleEnabled, true);
});

test('최근 해설 목록은 기본 4건', () => {
  const history = createNarrationHistory();
  ['하나 첫째 해설', '둘 둘째 해설', '셋 셋째 해설', '넷 넷째 해설', '다섯 다섯째 해설', '여섯 여섯째 해설']
    .forEach((text, index) => history.remember({ text, source: 'deixis', ts: index * 30000 }));
  assert.deepEqual(history.getRecentTextList(), ['셋 셋째 해설', '넷 넷째 해설', '다섯 다섯째 해설', '여섯 여섯째 해설']);
});
