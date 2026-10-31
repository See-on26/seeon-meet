// 고른 줄에서 확대할 상자를 정한다. 모든 좌표는 공유 화면 칸 기준 0~1 비율이다.
// 전환 프레임과 해설 프레임은 같은 칸을 같은 비율로 찍으므로 그림 크기가 달라도 그대로 맞는다.
const { ZOOM_KIND_MAP } = require('../../prompts/zoom-image-intro');
const { unionRect, centerDistance } = require('./label-matcher');

const ZOOM_RECT_STATUS_MAP = { used: 'used', noTarget: 'no_target', tooLarge: 'too_large', ambiguous: 'ambiguous' };

// 짧은 줄은 줄 상자 전체를 쓴다. 긴 줄(여러 칸을 이은 줄)은 글자 폭 비율로 낱말의 x 범위를 어림한다.
const SHORT_LINE_WIDTH = 0.3;
const WHOLE_LINE_WEIGHT_RATIO = 0.5;
// 어림 오차(칸 사이 넓은 간격을 공백 하나로 센 것, 비례 글꼴)를 덮는 양쪽 여백. 줄 폭 비율이다.
const SPAN_PADDING_RATIO = 0.15;
// 라벨 옆의 값(표), 위아래의 막대·눈금(그래프), 위아래 이웃 행이 들어오게 넓힌다.
const EXPAND_X_RATIO = 0.5;
const EXPAND_Y_LINE_COUNT = 3;
const EXPAND_MIN = 0.06;
// 확대 배율 1.7~2.5배. 넓힌 상자가 최대보다 크면 확대 이득이 작아 확대하지 않는다.
const ZOOM_MIN_SIDE = 0.4;
const ZOOM_MAX_SIDE = 0.6;
// 가리킴 상자와 발화 대상이 겹치거나 중심이 이만큼 안이면 같은 대상을 가리킨 것으로 본다.
const POINTING_NEAR_DISTANCE = 0.2;

const CHAR_WEIGHT_RULE_LIST = [
  { pattern: /[가-힣ㄱ-ㅎㅏ-ㅣ一-鿿぀-ヿ＀-￯]/, weight: 1 },
  { pattern: /[0-9A-Z]/, weight: 0.55 },
  { pattern: /[a-z]/, weight: 0.5 },
  { pattern: /\s/, weight: 0.5 },
];
const PUNCTUATION_WEIGHT = 0.3;

function readCharWeight(ch) {
  const rule = CHAR_WEIGHT_RULE_LIST.find((item) => item.pattern.test(ch));
  return rule ? rule.weight : PUNCTUATION_WEIGHT;
}

function sumWeight(text) {
  let total = 0;
  for (const ch of text) total += readCharWeight(ch);
  return total;
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

function clampRect(rect) {
  const x0 = clamp(rect.x, 0, 1);
  const y0 = clamp(rect.y, 0, 1);
  const x1 = clamp(rect.x + rect.w, 0, 1);
  const y1 = clamp(rect.y + rect.h, 0, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function isOverlapping(left, right) {
  return left.x < right.x + right.w && right.x < left.x + left.w && left.y < right.y + right.h && right.y < left.y + left.h;
}

// 줄 안 글자 범위 [charStart, charEnd) 의 상자. 어림했으면 spanEstimated=true.
function estimateSpanRect({ line, charStart, charEnd }) {
  const { rect } = line;
  const text = String(line.text || '');
  const isValidSpan = Number.isInteger(charStart) && Number.isInteger(charEnd) && charEnd > charStart;
  if (rect.w <= SHORT_LINE_WIDTH || !isValidSpan) return { rect: { ...rect }, spanEstimated: false };
  const totalWeight = sumWeight(text);
  const prefixWeight = sumWeight(text.slice(0, charStart));
  const matchWeight = sumWeight(text.slice(charStart, charEnd));
  if (!totalWeight || matchWeight / totalWeight >= WHOLE_LINE_WEIGHT_RATIO) return { rect: { ...rect }, spanEstimated: false };
  const padding = rect.w * SPAN_PADDING_RATIO;
  const x0 = Math.max(rect.x, rect.x + (rect.w * prefixWeight) / totalWeight - padding);
  const x1 = Math.min(rect.x + rect.w, rect.x + (rect.w * (prefixWeight + matchWeight)) / totalWeight + padding);
  return { rect: { x: x0, y: rect.y, w: x1 - x0, h: rect.h }, spanEstimated: true };
}

function expandTargetRect({ rect, lineHeight }) {
  const dx = Math.max(EXPAND_X_RATIO * rect.w, EXPAND_MIN);
  const dy = Math.max(EXPAND_Y_LINE_COUNT * (Number.isFinite(lineHeight) ? lineHeight : rect.h), EXPAND_MIN);
  return clampRect({ x: rect.x - dx, y: rect.y - dy, w: rect.w + 2 * dx, h: rect.h + 2 * dy });
}

// 비율 좌표에서 가로=세로로 맞춘다 → 잘린 그림의 가로세로비가 원래 화면과 같아 이미지 토큰을 고르게 쓴다.
// 화면 밖으로 나가면 줄이지 않고 안쪽으로 민다.
function fitZoomSquare(rect) {
  const clamped = clampRect(rect);
  if (Math.max(clamped.w, clamped.h) > ZOOM_MAX_SIDE + 1e-9) return { rect: null, isTooLarge: true };
  const side = Math.max(clamped.w, clamped.h, ZOOM_MIN_SIDE);
  const centerX = clamped.x + clamped.w / 2;
  const centerY = clamped.y + clamped.h / 2;
  return {
    rect: { x: clamp(centerX - side / 2, 0, 1 - side), y: clamp(centerY - side / 2, 0, 1 - side), w: side, h: side },
    isTooLarge: false,
  };
}

function buildSpeechSquare(targetList) {
  const targetRect = unionRect(targetList.map((target) => target.rect));
  const expanded = expandTargetRect({ rect: targetRect, lineHeight: targetList[0].lineHeight });
  return { targetRect, ...fitZoomSquare(expanded) };
}

// 대상 줄 목록(+가리킴 상자)에서 확대 상자를 정한다.
// 애매한 두 줄(peer, 멀리 떨어짐)은 합쳐 최대 크기 안일 때만 쓰고 아니면 ambiguous, 둘째 대상(second)은 넘치면 첫째만 쓴다.
function buildZoomRect({ targetList = [], pointingRect = null, ambiguity = null }) {
  const empty = { rect: null, targetRect: null, zoomKind: null, pointingConflict: false, targetCount: 0 };
  if (!targetList.length) return { ...empty, status: ZOOM_RECT_STATUS_MAP.noTarget };
  let usedList = targetList;
  let speech = buildSpeechSquare(usedList);
  if (speech.isTooLarge && usedList.length > 1) {
    if (ambiguity?.isAmbiguous) return { ...empty, status: ZOOM_RECT_STATUS_MAP.ambiguous };
    usedList = [targetList[0]];
    speech = buildSpeechSquare(usedList);
  }
  if (speech.isTooLarge) return { ...empty, status: ZOOM_RECT_STATUS_MAP.tooLarge };
  const base = {
    status: ZOOM_RECT_STATUS_MAP.used, targetRect: speech.targetRect, targetCount: usedList.length,
    rect: speech.rect, zoomKind: ZOOM_KIND_MAP.speech, pointingConflict: false,
  };
  if (!pointingRect) return base;
  const isNear = isOverlapping(speech.targetRect, pointingRect)
    || centerDistance(speech.targetRect, pointingRect) <= POINTING_NEAR_DISTANCE;
  // 떨어져 있으면 이름을 말한 라벨 쪽이 더 구체적이다. 화소 차 가리킴은 웹캠·커서를 잡은 일이 있었다.
  if (!isNear) return { ...base, pointingConflict: true };
  const merged = fitZoomSquare(unionRect([speech.rect, pointingRect]));
  return merged.isTooLarge ? base : { ...base, rect: merged.rect, zoomKind: ZOOM_KIND_MAP.merged };
}

module.exports = {
  estimateSpanRect, buildZoomRect, fitZoomSquare, ZOOM_RECT_STATUS_MAP, ZOOM_MIN_SIDE, ZOOM_MAX_SIDE, SPAN_PADDING_RATIO,
  POINTING_NEAR_DISTANCE,
};
