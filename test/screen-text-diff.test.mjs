import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  diffScreenText, normalizeOcrLineText, SCREEN_TEXT_DIFF_KIND_MAP, SCREEN_TEXT_DIFF_SKIP_MAP,
} = require('../src/main/caption-pipeline/orchestrator/screen-text-diff.js');

const IMAGE = { imageWidth: 1000, imageHeight: 1000 };

function line(text, { left = 100, top = 100, width = 300, height = 40, score = 0.98 } = {}) {
  return { text, left, top, width, height, score };
}

function screen(lineList) {
  return { lineList, ...IMAGE };
}

const texts = (result) => result.addedLineList.map((entry) => entry.text);

test('기준 [A,B] 에 "매출 42억" 줄이 생기면 새 줄 하나, 종류는 new_text', () => {
  const baseline = screen([line('분기 실적', { top: 50 }), line('영업이익 추이', { top: 150 })]);
  const current = screen([line('분기 실적', { top: 50 }), line('영업이익 추이', { top: 150 }), line('매출 42억', { top: 250 })]);
  const result = diffScreenText({ baseline, current });
  assert.equal(result.kind, SCREEN_TEXT_DIFF_KIND_MAP.newText);
  assert.equal(result.skipReason, null);
  assert.deepEqual(texts(result), ['매출 42억']);
});

test('띄어쓰기·천 단위 쉼표만 다른 줄은 새 줄이 아니다', () => {
  assert.equal(normalizeOcrLineText('42 %'), normalizeOcrLineText('42%'));
  assert.equal(normalizeOcrLineText('1,234'), normalizeOcrLineText('1234'));
  assert.notEqual(normalizeOcrLineText('4.2'), normalizeOcrLineText('42'));
  const result = diffScreenText({
    baseline: screen([line('42 %'), line('1,234', { top: 200 })]),
    current: screen([line('42%'), line('1234', { top: 200 })]),
  });
  assert.deepEqual(texts(result), []);
});

test('같은 자리에서 "37%"가 "42%"로 바뀌면 새 줄로 센다', () => {
  const result = diffScreenText({
    baseline: screen([line('제목', { top: 20 }), line('37%', { top: 300 })]),
    current: screen([line('제목', { top: 20 }), line('42%', { top: 300 })]),
  });
  assert.equal(result.kind, SCREEN_TEXT_DIFF_KIND_MAP.newText);
  assert.deepEqual(texts(result), ['42%']);
  assert.equal(result.removedLineCount, 1);
});

test('영역을 주면 영역과 여백 밖의 새 줄은 버리고 안의 새 줄만 남긴다', () => {
  const baseline = screen([line('제목', { top: 20 })]);
  const current = screen([
    line('제목', { top: 20 }),
    line('안쪽 값 17%', { left: 600, top: 600, width: 200, height: 40 }),
    line('여백 안 값 9%', { left: 560, top: 820, width: 100, height: 30 }),
    line('바깥 흔들림 2.318', { left: 50, top: 900, width: 150, height: 30 }),
  ]);
  const regionNorm = { x: 0.6, y: 0.6, w: 0.2, h: 0.2 };
  const result = diffScreenText({ baseline, current, regionNorm });
  assert.deepEqual(texts(result), ['안쪽 값 17%', '여백 안 값 9%']);
  assert.equal(result.addedLineCountTotal, 3);
});

test('점수 0.85 미만 줄은 새 줄로 보지 않는다', () => {
  const result = diffScreenText({
    baseline: screen([line('제목')]),
    current: screen([line('제목'), line('흐린 글자 88', { top: 300, score: 0.8 })]),
  });
  assert.deepEqual(texts(result), []);
});

test('기준에 "합계"가 한 줄, 지금 두 줄이면 새 줄은 하나다', () => {
  const result = diffScreenText({
    baseline: screen([line('합계', { top: 100 })]),
    current: screen([line('합계', { top: 100 }), line('합계', { top: 500 })]),
  });
  assert.equal(result.addedLineList.length, 1);
  assert.equal(result.addedLineList[0].top, 500);
});

test('글 변화가 없으면 영역이 기준 줄과 겹칠 때 highlight, 겹치지 않으면 visual', () => {
  const baseline = screen([line('보기 1번 서울', { left: 100, top: 300, width: 300, height: 40 })]);
  const current = screen([line('보기 1번 서울', { left: 100, top: 300, width: 300, height: 40 })]);
  const over = diffScreenText({ baseline, current, regionNorm: { x: 0.08, y: 0.28, w: 0.4, h: 0.1 } });
  assert.equal(over.kind, SCREEN_TEXT_DIFF_KIND_MAP.highlight);
  assert.deepEqual(texts(over), []);
  assert.deepEqual(over.regionLineList.map((entry) => entry.text), ['보기 1번 서울']);
  const apart = diffScreenText({ baseline, current, regionNorm: { x: 0.7, y: 0.7, w: 0.1, h: 0.1 } });
  assert.equal(apart.kind, SCREEN_TEXT_DIFF_KIND_MAP.visual);
});

test('맞춰진 줄이 모두 아래로 40px 움직이면 스크롤로 본다', () => {
  const baseline = screen([line('첫 줄', { top: 100 }), line('둘째 줄', { top: 200 }), line('셋째 줄', { top: 300 })]);
  const current = screen([
    line('첫 줄', { top: 140 }), line('둘째 줄', { top: 240 }), line('셋째 줄', { top: 340 }), line('새로 보인 줄', { top: 440 }),
  ]);
  const result = diffScreenText({ baseline, current });
  assert.equal(result.skipReason, SCREEN_TEXT_DIFF_SKIP_MAP.scroll);
});

test('기준이 없으면 baseline_missing 이다 — 화면 전체를 새 글자로 보지 않는다', () => {
  const result = diffScreenText({ baseline: null, current: screen([line('제목'), line('값 42%', { top: 300 })]) });
  assert.equal(result.skipReason, SCREEN_TEXT_DIFF_SKIP_MAP.baselineMissing);
  assert.deepEqual(texts(result), []);
});
