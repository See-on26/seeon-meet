// 재생 화면 ROI 계산. 정규화 사각형(0~1)은 영상이 실제로 보이는 영역 기준이라 창 크기가 바뀌어도 영상에 붙어 있다.
export const MIN_ROI_RATIO = 0.02;
export const FULL_NORM_RECT = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

// object-fit: contain 으로 그린 영상의 표시 영역(레터박스 제외). 영상 크기를 모르면 화면 전체다.
export function computeContainRect({ boxWidth, boxHeight, mediaWidth, mediaHeight }) {
  if (!(boxWidth > 0) || !(boxHeight > 0)) return null;
  if (!(mediaWidth > 0) || !(mediaHeight > 0)) return { x: 0, y: 0, w: boxWidth, h: boxHeight };
  const scale = Math.min(boxWidth / mediaWidth, boxHeight / mediaHeight);
  const w = mediaWidth * scale;
  const h = mediaHeight * scale;
  return { x: (boxWidth - w) / 2, y: (boxHeight - h) / 2, w, h };
}

export function clampNormPoint({ x, y }) {
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

export function rectFromPoints({ from, to }) {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(from.x - to.x), h: Math.abs(from.y - to.y) };
}

// 너무 작은 드래그는 잘못 누른 것으로 본다.
export function isUsableNormRect(rect) {
  return Boolean(rect) && rect.w >= MIN_ROI_RATIO && rect.h >= MIN_ROI_RATIO;
}

export function normToContentPx({ normRect, contentRect }) {
  return {
    x: contentRect.x + normRect.x * contentRect.w,
    y: contentRect.y + normRect.y * contentRect.h,
    w: normRect.w * contentRect.w,
    h: normRect.h * contentRect.h,
  };
}

export function pxToContentNorm({ point, contentRect }) {
  return clampNormPoint({ x: (point.x - contentRect.x) / contentRect.w, y: (point.y - contentRect.y) / contentRect.h });
}
