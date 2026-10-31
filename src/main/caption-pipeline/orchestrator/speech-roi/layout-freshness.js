// 전환 때 뽑아 둔 줄 위치를 지금 화면에 써도 되는지 본다. 같은 프레임 OCR 위치에는 쓰지 않는다(에이전트가 보는 그림과 같다).
// 문턱값은 원리로 정한 시작값이다: 렌더러가 공유 화면 칸 비율을 같은 화면으로 보는 허용치(2%), 슬라이드가 바뀐 정도의 전체 차이,
// 스크롤·클릭 등장이 대상 상자를 덮는 정도. 레이저 점·커서는 상자 면적의 몇 %라 걸리지 않는다.

const FRESHNESS_REASON_MAP = { layoutChanged: 'layout_changed', slideChanged: 'slide_changed', contentMoved: 'content_moved' };

const MAX_ASPECT_DIFF = 0.02;
const MAX_GLOBAL_DIFF = 18;
const MAX_BOX_DIFF = 22;
const CHANGED_PIXEL_DIFF = 40;
const MAX_CHANGED_PIXEL_RATIO = 0.25;

const round = (value, digit = 2) => (Number.isFinite(value) ? Math.round(value * 10 ** digit) / 10 ** digit : null);

function isSameThumbShape(left, right) {
  return Boolean(left?.data && right?.data) && left.width === right.width && left.height === right.height
    && left.data.length === right.data.length;
}

function meanAbsDiff(left, right) {
  let total = 0;
  for (let index = 0; index < left.data.length; index += 1) total += Math.abs(left.data[index] - right.data[index]);
  return total / left.data.length;
}

// 비율 상자 안 화소의 평균 차이와 크게 바뀐 화소 비율. 상자가 한 화소보다 작아도 한 화소는 본다.
function measureBoxDiff({ left, right, rect }) {
  const x0 = Math.max(0, Math.floor(rect.x * left.width));
  const y0 = Math.max(0, Math.floor(rect.y * left.height));
  const x1 = Math.min(left.width, Math.max(x0 + 1, Math.ceil((rect.x + rect.w) * left.width)));
  const y1 = Math.min(left.height, Math.max(y0 + 1, Math.ceil((rect.y + rect.h) * left.height)));
  let total = 0;
  let changedCount = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const diff = Math.abs(left.data[y * left.width + x] - right.data[y * left.width + x]);
      total += diff;
      if (diff > CHANGED_PIXEL_DIFF) changedCount += 1;
      count += 1;
    }
  }
  return count ? { boxDiff: total / count, changedRatio: changedCount / count } : { boxDiff: 0, changedRatio: 0 };
}

// targetRect 가 없으면 화면 비율·전체 차이만 본다(줄을 고르기 전 확인). 낡았으면 reason 에 까닭을 남긴다.
function checkLayoutFreshness({ layout, currentThumb, currentAspect, targetRect = null }) {
  const result = { isFresh: false, reason: null, aspectDiff: null, globalDiff: null, boxDiff: null, changedRatio: null };
  const aspectDiff = Number.isFinite(currentAspect) && Number.isFinite(layout?.aspect) && layout.aspect > 0
    ? Math.abs(currentAspect / layout.aspect - 1) : Infinity;
  result.aspectDiff = round(aspectDiff, 4);
  if (aspectDiff > MAX_ASPECT_DIFF) return { ...result, reason: FRESHNESS_REASON_MAP.layoutChanged };
  if (!isSameThumbShape(layout?.thumb, currentThumb)) return { ...result, reason: FRESHNESS_REASON_MAP.slideChanged };
  const globalDiff = meanAbsDiff(layout.thumb, currentThumb);
  result.globalDiff = round(globalDiff);
  if (globalDiff > MAX_GLOBAL_DIFF) return { ...result, reason: FRESHNESS_REASON_MAP.slideChanged };
  if (targetRect) {
    const { boxDiff, changedRatio } = measureBoxDiff({ left: layout.thumb, right: currentThumb, rect: targetRect });
    result.boxDiff = round(boxDiff);
    result.changedRatio = round(changedRatio, 3);
    if (boxDiff > MAX_BOX_DIFF || changedRatio > MAX_CHANGED_PIXEL_RATIO) return { ...result, reason: FRESHNESS_REASON_MAP.contentMoved };
  }
  return { ...result, isFresh: true };
}

module.exports = {
  checkLayoutFreshness, FRESHNESS_REASON_MAP, MAX_ASPECT_DIFF, MAX_GLOBAL_DIFF, MAX_BOX_DIFF, CHANGED_PIXEL_DIFF, MAX_CHANGED_PIXEL_RATIO,
};
