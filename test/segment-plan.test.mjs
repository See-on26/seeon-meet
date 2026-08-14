import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listSegments, DEFAULT_MAX_SEGMENT_MS } = require('../src/main/caption-pipeline/context/segment-plan.js');

function slide(major, visitList) {
  return { major, visitList };
}

test('segment-plan: 방문마다 구간 하나, 같은 슬라이드로 돌아오면 isRevisit', () => {
  const snapshot = {
    startedAt: 0,
    slideList: [
      slide(1, [{ startTs: 0, endTs: 60000 }, { startTs: 120000, endTs: null }]),
      slide(2, [{ startTs: 60000, endTs: 120000 }]),
    ],
    utteranceList: [{ ts: 1000, text: '시작하겠습니다' }],
  };
  assert.deepEqual(listSegments({ snapshot, endTs: 180000 }), [
    { key: '1@0', slideMajor: 1, startTs: 0, endTs: 60000, isRevisit: false, isOpenTail: false },
    { key: '2@60000', slideMajor: 2, startTs: 60000, endTs: 120000, isRevisit: false, isOpenTail: false },
    { key: '1@120000', slideMajor: 1, startTs: 120000, endTs: 180000, isRevisit: true, isOpenTail: true },
  ]);
});

test('segment-plan: 5초 미만 방문과 취소된 전환은 구간이 아니다', () => {
  const snapshot = {
    startedAt: 0,
    slideList: [
      slide(1, [{ startTs: 0, endTs: 60000 }]),
      slide(2, [{ startTs: 60000, endTs: 63000 }, { startTs: 190000, endTs: 250000 }]),
      // 취소된 전환의 방문은 길이와 상관없이 뺀다.
      slide(3, [{ startTs: 63000, endTs: 69000 }, { startTs: 130000, endTs: 190000 }]),
      slide(4, [{ startTs: 69000, endTs: 130000 }]),
    ],
    cancelledTransitionList: [{ slideMajor: 3, requestTs: 63100, transitionTs: 63000 }],
    utteranceList: [],
  };
  assert.deepEqual(listSegments({ snapshot }).map(({ key, isRevisit }) => [key, isRevisit]), [
    ['1@0', false],
    ['4@69000', false],
    // 앞 방문이 취소됐으면 처음 온 것이고, 짧아서 구간이 아니었던 방문은 살아 있으므로 다시 온 것이다.
    ['3@130000', false],
    ['2@190000', true],
  ]);
  const exactSnapshot = { startedAt: 0, slideList: [slide(1, [{ startTs: 0, endTs: 5000 }])], utteranceList: [] };
  assert.deepEqual(listSegments({ snapshot: exactSnapshot }).map(({ key }) => key), ['1@0'], '딱 5초는 구간이다');
});

test('segment-plan: 긴 방문은 방문 시작부터 maxSegmentMs 고정 경계로 자르고 key 가 다시 계산해도 같다', () => {
  const snapshot = {
    startedAt: 0,
    slideList: [slide(1, [{ startTs: 0, endTs: null }])],
    utteranceList: [],
  };
  const laterList = listSegments({ snapshot, endTs: 700000, maxSegmentMs: 300000 });
  assert.deepEqual(laterList.map(({ key, startTs, endTs, isOpenTail }) => [key, startTs, endTs, isOpenTail]), [
    ['1@0', 0, 300000, false],
    ['1@300000', 300000, 600000, false],
    ['1@600000', 600000, 700000, true],
  ]);
  const earlierList = listSegments({ snapshot, endTs: 650000, maxSegmentMs: 300000 });
  assert.deepEqual(earlierList.map(({ key }) => key), ['1@0', '1@300000', '1@600000']);
  assert.deepEqual(earlierList.slice(0, 2), laterList.slice(0, 2));
  assert.equal(earlierList[2].endTs, 650000);

  const revisitSnapshot = {
    startedAt: 0,
    slideList: [
      slide(1, [{ startTs: 0, endTs: 10000 }, { startTs: 20000, endTs: 640000 }]),
      slide(2, [{ startTs: 10000, endTs: 20000 }]),
    ],
    utteranceList: [],
  };
  assert.deepEqual(listSegments({ snapshot: revisitSnapshot, maxSegmentMs: 300000 })
    .map(({ key, isRevisit, isOpenTail }) => [key, isRevisit, isOpenTail]), [
    ['1@0', false, false],
    ['2@10000', false, false],
    ['1@20000', true, false],
    ['1@320000', true, false],
    ['1@620000', true, false],
  ], '닫힌 방문의 조각은 모두 isOpenTail 이 거짓이고, 다시 온 방문의 조각은 모두 isRevisit 이다');

  assert.throws(() => listSegments({ snapshot, endTs: 700000, maxSegmentMs: 0 }), RangeError);
});

test('segment-plan: 화면이 없는 회의는 시작 시각부터 시간으로 끊는다', () => {
  const snapshot = {
    startedAt: 1000,
    slideList: [],
    utteranceList: [{ ts: 2000, text: '시작하겠습니다' }],
  };
  assert.deepEqual(listSegments({ snapshot, endTs: 651000, maxSegmentMs: 300000 }), [
    { key: 'none@1000', slideMajor: null, startTs: 1000, endTs: 301000, isRevisit: false, isOpenTail: false },
    { key: 'none@301000', slideMajor: null, startTs: 301000, endTs: 601000, isRevisit: false, isOpenTail: false },
    { key: 'none@601000', slideMajor: null, startTs: 601000, endTs: 651000, isRevisit: false, isOpenTail: true },
  ]);
  const flashOnlySnapshot = {
    ...snapshot,
    slideList: [slide(5, [{ startTs: 50000, endTs: null }])],
    cancelledTransitionList: [{ slideMajor: 5, requestTs: 50100, transitionTs: 50000 }],
  };
  assert.deepEqual(listSegments({ snapshot: flashOnlySnapshot, endTs: 651000, maxSegmentMs: 300000 }).map(({ key }) => key),
    ['none@1000', 'none@301000', 'none@601000'], '취소된 방문만 있으면 방문이 없는 회의다');
});

test('segment-plan: 첫 방문 전에 발화가 있으면 화면 없는 구간을 두고, 발화가 없으면 두지 않는다', () => {
  const snapshot = {
    startedAt: 0,
    slideList: [slide(1, [{ startTs: 30000, endTs: null }])],
    utteranceList: [{ ts: 2000, text: '시작하겠습니다' }, { ts: 31000, text: '첫 화면입니다' }],
  };
  assert.deepEqual(listSegments({ snapshot }), [
    { key: 'none@0', slideMajor: null, startTs: 0, endTs: 30000, isRevisit: false, isOpenTail: false },
  ], '첫 방문이 아직 열려 있어도 그 앞 구간은 닫혀 있다');
  assert.deepEqual(listSegments({ snapshot, endTs: 90000 }).map(({ key }) => key), ['none@0', '1@30000']);
  const silentSnapshot = { ...snapshot, utteranceList: [{ ts: 31000, text: '첫 화면입니다' }] };
  assert.deepEqual(listSegments({ snapshot: silentSnapshot, endTs: 90000 }).map(({ key }) => key), ['1@30000']);
});

test('segment-plan: 열린 방문은 endTs 가 없으면 구간에 넣지 않는다', () => {
  const snapshot = {
    startedAt: 0,
    slideList: [
      slide(1, [{ startTs: 0, endTs: 60000 }]),
      slide(2, [{ startTs: 60000, endTs: null }]),
    ],
    utteranceList: [],
  };
  assert.deepEqual(listSegments({ snapshot }).map(({ key }) => key), ['1@0']);
  assert.deepEqual(listSegments({ snapshot: { startedAt: 0, slideList: [], utteranceList: [] } }), [],
    '방문이 없는 회의도 끝 시각이 없으면 구간이 없다');
});

test('segment-plan: 취소된 방문만 사이에 둔 같은 슬라이드의 방문은 한 방문이다', () => {
  // 1 → 2(취소) → 1: 화면은 슬라이드 1 그대로였으므로 다시 온 방문이 아니다.
  const snapshot = {
    startedAt: 0,
    slideList: [
      slide(1, [{ startTs: 0, endTs: 60000 }, { startTs: 62000, endTs: 120000 }]),
      slide(2, [{ startTs: 60000, endTs: 62000 }]),
      slide(3, [{ startTs: 120000, endTs: null }]),
    ],
    cancelledTransitionList: [{ slideMajor: 2, requestTs: 60100, transitionTs: 60000 }],
    utteranceList: [],
  };
  assert.deepEqual(listSegments({ snapshot, endTs: 180000 }), [
    { key: '1@0', slideMajor: 1, startTs: 0, endTs: 120000, isRevisit: false, isOpenTail: false },
    { key: '3@120000', slideMajor: 3, startTs: 120000, endTs: 180000, isRevisit: false, isOpenTail: true },
  ]);

  // 취소된 방문이 여럿 끼어도, 돌아온 방문이 아직 열려 있어도 한 방문이다.
  const openSnapshot = {
    startedAt: 0,
    slideList: [
      slide(1, [{ startTs: 0, endTs: 60000 }, { startTs: 64000, endTs: null }]),
      slide(2, [{ startTs: 60000, endTs: 62000 }]),
      slide(3, [{ startTs: 62000, endTs: 64000 }]),
    ],
    cancelledTransitionList: [
      { slideMajor: 2, requestTs: 60100, transitionTs: 60000 },
      { slideMajor: 3, requestTs: 62100, transitionTs: 62000 },
    ],
    utteranceList: [],
  };
  assert.deepEqual(listSegments({ snapshot: openSnapshot, endTs: 90000 }), [
    { key: '1@0', slideMajor: 1, startTs: 0, endTs: 90000, isRevisit: false, isOpenTail: true },
  ]);
  assert.deepEqual(listSegments({ snapshot: openSnapshot }), [], '합친 방문이 열려 있으면 끝 시각 없이는 구간이 아니다');

  // 사이에 살아 있는 방문이 있으면(5초 미만이라 구간이 아니어도) 다시 온 방문이다.
  const liveBetweenSnapshot = { ...snapshot, cancelledTransitionList: [] };
  assert.deepEqual(listSegments({ snapshot: liveBetweenSnapshot, endTs: 180000 }).map(({ key, isRevisit }) => [key, isRevisit]), [
    ['1@0', false],
    ['1@62000', true],
    ['3@120000', false],
  ]);
});

test('segment-plan: 구간 길이 상한을 내보낸다(회의 중 스케줄러가 같은 값을 쓴다)', () => {
  assert.equal(DEFAULT_MAX_SEGMENT_MS, 300000);
});
