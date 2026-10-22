import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  estimateSpanRect, buildZoomRect, ZOOM_RECT_STATUS_MAP, ZOOM_MIN_SIDE, ZOOM_MAX_SIDE, SPAN_PADDING_RATIO,
} = require('../src/main/caption-pipeline/orchestrator/speech-roi/roi-rect.js');
const { ZOOM_KIND_MAP } = require('../src/main/caption-pipeline/prompts/zoom-image-intro.js');

const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-6, `${label} ${actual} ≠ ${expected}`);
const nearRect = (actual, expected) => {
  for (const key of ['x', 'y', 'w', 'h']) near(actual[key], expected[key], key);
};

test('x 어림: 짧은 줄(화면 폭 0.3 이하)은 줄 상자 전체를 쓴다', () => {
  const line = { text: '서울 2024', rect: { x: 0.2, y: 0.4, w: 0.3, h: 0.04 } };
  const { rect, spanEstimated } = estimateSpanRect({ line, charStart: 0, charEnd: 2 });
  assert.equal(spanEstimated, false);
  assert.deepEqual(rect, line.rect);
});

test('x 어림: 긴 줄은 글자 폭 가중 비율로 범위를 어림하고 줄 폭의 15%를 양쪽 여백으로 더한다', () => {
  assert.equal(SPAN_PADDING_RATIO, 0.15);
  const text = '2019 2020 2021 2022 2023';
  const line = { text, rect: { x: 0.1, y: 0.8, w: 0.8, h: 0.04 } };
  const charStart = text.indexOf('2021');
  const { rect, spanEstimated } = estimateSpanRect({ line, charStart, charEnd: charStart + 4 });
  assert.equal(spanEstimated, true);
  // 숫자 0.55·공백 0.5: 앞부분 5.4, 맞은 부분 2.2, 전체 13.
  near(rect.x, 0.1 + 0.8 * (5.4 / 13) - 0.12, 'x');
  near(rect.x + rect.w, 0.1 + 0.8 * (7.6 / 13) + 0.12, 'right');
  near(rect.y, 0.8);
  near(rect.h, 0.04);
});

test('x 어림: 한글은 숫자보다 넓게 세고, 맞은 부분이 줄 글 무게의 절반 이상이면 줄 전체를 쓴다', () => {
  const line = { text: '매출액 합계', rect: { x: 0.1, y: 0.5, w: 0.5, h: 0.04 } };
  assert.equal(estimateSpanRect({ line, charStart: 0, charEnd: 3 }).spanEstimated, false);
  const mixed = { text: '서울 1234 5678 9012', rect: { x: 0.1, y: 0.5, w: 0.8, h: 0.04 } };
  const { rect } = estimateSpanRect({ line: mixed, charStart: 0, charEnd: 2 });
  // 서울 2.0 / (2.0 + 0.5×3 + 0.55×12) = 2/10.1
  near(rect.x, 0.1, 'x 는 줄 왼쪽 밖으로 나가지 않는다');
  near(rect.x + rect.w, 0.1 + 0.8 * (2 / 10.1) + 0.12, 'right');
});

test('확대 상자: 둘레를 넓히고 최소 0.4 · 화면과 같은 비율(정사각 비율 좌표)로 맞춘다', () => {
  assert.equal(ZOOM_MIN_SIDE, 0.4);
  assert.equal(ZOOM_MAX_SIDE, 0.6);
  const result = buildZoomRect({ targetList: [{ rect: { x: 0.45, y: 0.48, w: 0.1, h: 0.04 }, lineHeight: 0.04 }] });
  assert.equal(result.status, ZOOM_RECT_STATUS_MAP.used);
  assert.equal(result.zoomKind, ZOOM_KIND_MAP.speech);
  nearRect(result.rect, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
});

test('확대 상자: 넓힌 상자가 0.4 보다 크면 그 크기의 정사각, 가장자리에서는 줄이지 않고 안쪽으로 민다', () => {
  const wide = buildZoomRect({ targetList: [{ rect: { x: 0.35, y: 0.5, w: 0.25, h: 0.04 }, lineHeight: 0.04 }] });
  // 가로 0.25 + 양쪽 0.125 = 0.5
  near(wide.rect.w, 0.5);
  near(wide.rect.h, 0.5);
  const corner = buildZoomRect({ targetList: [{ rect: { x: 0.9, y: 0.92, w: 0.08, h: 0.04 }, lineHeight: 0.04 }] });
  nearRect(corner.rect, { x: 0.6, y: 0.6, w: 0.4, h: 0.4 });
});

test('확대 상자: 넓힌 상자의 변이 0.6 을 넘으면 확대하지 않는다(too_large)', () => {
  const result = buildZoomRect({ targetList: [{ rect: { x: 0.1, y: 0.5, w: 0.6, h: 0.04 }, lineHeight: 0.04 }] });
  assert.equal(result.status, ZOOM_RECT_STATUS_MAP.tooLarge);
  assert.equal(result.rect, null);
});

test('확대 상자: 애매한 두 줄은 합쳐 최대 크기 안이면 쓰고 아니면 ambiguous, 둘째 대상은 넘치면 첫째만', () => {
  const nearPair = buildZoomRect({
    targetList: [{ rect: { x: 0.3, y: 0.4, w: 0.1, h: 0.04 }, lineHeight: 0.04 }, { rect: { x: 0.3, y: 0.5, w: 0.1, h: 0.04 }, lineHeight: 0.04, role: 'peer' }],
    ambiguity: { isAmbiguous: true },
  });
  assert.equal(nearPair.status, ZOOM_RECT_STATUS_MAP.used);
  assert.equal(nearPair.targetCount, 2);
  const farPair = buildZoomRect({
    targetList: [{ rect: { x: 0.05, y: 0.1, w: 0.1, h: 0.04 }, lineHeight: 0.04 }, { rect: { x: 0.8, y: 0.85, w: 0.1, h: 0.04 }, lineHeight: 0.04, role: 'peer' }],
    ambiguity: { isAmbiguous: true },
  });
  assert.equal(farPair.status, ZOOM_RECT_STATUS_MAP.ambiguous);
  const farSecond = buildZoomRect({
    targetList: [{ rect: { x: 0.05, y: 0.1, w: 0.1, h: 0.04 }, lineHeight: 0.04 }, { rect: { x: 0.8, y: 0.85, w: 0.1, h: 0.04 }, lineHeight: 0.04, role: 'second' }],
  });
  assert.equal(farSecond.status, ZOOM_RECT_STATUS_MAP.used);
  assert.equal(farSecond.targetCount, 1);
});

// 가리킴(P)과 발화(S): 렌더러가 보낸 P 는 여백 0.12 를 이미 더한 비율 상자다.
const speechTarget = [{ rect: { x: 0.45, y: 0.48, w: 0.1, h: 0.04 }, lineHeight: 0.04 }];

test('가리킴과 발화: 겹치거나 가까우면 P∪S 를 같은 규칙으로 자른다(merged)', () => {
  const result = buildZoomRect({ targetList: speechTarget, pointingRect: { x: 0.4, y: 0.4, w: 0.3, h: 0.3 } });
  assert.equal(result.zoomKind, ZOOM_KIND_MAP.merged);
  assert.equal(result.pointingConflict, false);
  assert.ok(result.rect.x <= 0.3 + 1e-9 && result.rect.x + result.rect.w >= 0.7 - 1e-9);
  near(result.rect.w, result.rect.h);
});

test('가리킴과 발화: 합친 상자가 최대를 넘으면 발화 상자 S 를 쓴다', () => {
  const result = buildZoomRect({ targetList: speechTarget, pointingRect: { x: 0.5, y: 0.5, w: 0.45, h: 0.45 } });
  assert.equal(result.zoomKind, ZOOM_KIND_MAP.speech);
  assert.equal(result.pointingConflict, false);
  nearRect(result.rect, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
});

test('가리킴과 발화: 떨어져 있으면 발화 쪽 S 를 쓰고 충돌로 남긴다', () => {
  const result = buildZoomRect({ targetList: speechTarget, pointingRect: { x: 0.0, y: 0.0, w: 0.15, h: 0.15 } });
  assert.equal(result.zoomKind, ZOOM_KIND_MAP.speech);
  assert.equal(result.pointingConflict, true);
  nearRect(result.rect, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
});

test('가리킴과 발화: 발화 대상이 없으면 확대 상자도 없다(가리킴만인 경우는 해설 유형에 따라 위에서 정한다)', () => {
  const result = buildZoomRect({ targetList: [], pointingRect: { x: 0.4, y: 0.4, w: 0.3, h: 0.3 } });
  assert.equal(result.status, ZOOM_RECT_STATUS_MAP.noTarget);
  assert.equal(result.rect, null);
});
