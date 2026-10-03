import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNarrationHistory } = require('../src/main/caption-pipeline/orchestrator/narration-history.js');
const { createDescribedStore } = require('../src/main/caption-pipeline/orchestrator/described-store.js');

test('렌더러가 버린 해설은 중복 억제 기록에서 지워 같은 대상을 다시 해설할 수 있다', () => {
  const history = createNarrationHistory({});
  history.remember({ text: '파란 막대그래프', source: 'deixis', ts: 100, slideLabel: '3' });
  history.remember({ text: '빨간 원그래프', source: 'deixis', ts: 200, slideLabel: '3' });
  assert.equal(history.findDuplicate({ text: '파란 막대그래프', source: 'deixis', slideLabel: '3' }).isDuplicate, true);

  assert.equal(history.forget({ ts: 100, text: '파란 막대그래프' }), true);
  assert.equal(history.findDuplicate({ text: '파란 막대그래프', source: 'deixis', slideLabel: '3' }).isDuplicate, false);
  assert.deepEqual(history.getRecentTextList(), ['빨간 원그래프']);
  assert.equal(history.forget({ ts: 999, text: '없는 해설' }), false);
});

test('렌더러가 버린 해설의 요소는 재설명 금지 목록에서 뺀다', () => {
  const store = createDescribedStore();
  store.addDescribed('3-1', ['막대그래프', '제목']);
  store.addDescribed('3', ['원그래프']);
  store.removeDescribed('3', ['막대그래프', '없는 요소']);
  assert.deepEqual(store.getDescribed('3'), ['제목', '원그래프']);
});
