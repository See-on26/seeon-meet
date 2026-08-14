import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecentPointingMemory, POINTING_RECALL_LOOKBACK_MS,
} from '../src/renderer/core/trigger/recent-pointing.js';

const jejuRegion = { x: 0.55, y: 0.62, w: 0.14, h: 0.14 };
const otherRegion = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 };

// 말하면서 가리키면 펜은 말보다 먼저 움직이고, "여기"가 든 문장은 ASR 조각이 끝난 뒤에 온다.
// 그 사이 대기 후보가 없어 버려지던 영역을 같은 슬라이드면 뒤늦게 온 지시 발화에 붙인다.
test('가리킨 뒤 몇 초 늦게 온 지시 발화에 같은 슬라이드에서 가리킨 영역을 붙인다', () => {
  const memory = createRecentPointingMemory();
  memory.remember({ region: jejuRegion, pointingOrderHint: '', wallTs: 10_000, slideLabel: '1' });
  assert.deepEqual(memory.recall({ eventWallTs: 13_500, slideLabel: '1' }), { region: jejuRegion, pointingOrderHint: '' });
});

test('슬라이드가 바뀐 뒤의 지시 발화에는 앞 슬라이드에서 가리킨 영역을 붙이지 않는다', () => {
  const memory = createRecentPointingMemory();
  memory.remember({ region: jejuRegion, wallTs: 10_000, slideLabel: '1' });
  assert.equal(memory.recall({ eventWallTs: 12_000, slideLabel: '2' }), null);
});

test('지시 발화보다 한참 전에 가리킨 영역은 붙이지 않는다', () => {
  const memory = createRecentPointingMemory();
  memory.remember({ region: jejuRegion, wallTs: 10_000, slideLabel: '1' });
  assert.equal(memory.recall({ eventWallTs: 10_000 + POINTING_RECALL_LOOKBACK_MS + 1, slideLabel: '1' }), null);
  assert.ok(memory.recall({ eventWallTs: 10_000 + POINTING_RECALL_LOOKBACK_MS, slideLabel: '1' }));
});

test('여러 번 가리켰으면 가장 최근 영역을 붙인다', () => {
  const memory = createRecentPointingMemory();
  memory.remember({ region: otherRegion, wallTs: 9_000, slideLabel: '1' });
  memory.remember({ region: jejuRegion, pointingOrderHint: '1) 왼쪽 아래', wallTs: 11_000, slideLabel: '1' });
  assert.deepEqual(memory.recall({ eventWallTs: 13_000, slideLabel: '1' }), { region: jejuRegion, pointingOrderHint: '1) 왼쪽 아래' });
});

test('지우면(캡처 다시 시작·공유 화면 영역 변경) 기억한 영역을 붙이지 않는다', () => {
  const memory = createRecentPointingMemory();
  memory.remember({ region: jejuRegion, wallTs: 10_000, slideLabel: '1' });
  memory.reset();
  assert.equal(memory.recall({ eventWallTs: 11_000, slideLabel: '1' }), null);
});

test('영역이 없거나 시각을 모르면 기억하지 않고, 발화 시각을 모르면 붙이지 않는다', () => {
  const memory = createRecentPointingMemory();
  memory.remember({ region: null, wallTs: 10_000, slideLabel: '1' });
  memory.remember({ region: jejuRegion, wallTs: null, slideLabel: '1' });
  assert.equal(memory.recall({ eventWallTs: 10_500, slideLabel: '1' }), null);
  memory.remember({ region: jejuRegion, wallTs: 10_000, slideLabel: '1' });
  assert.equal(memory.recall({ eventWallTs: null, slideLabel: '1' }), null);
});
