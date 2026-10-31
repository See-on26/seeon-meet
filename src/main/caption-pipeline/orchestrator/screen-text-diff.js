// 같은 슬라이드 안 화면 변화 사건에서 새로 나타난 글자를 찾는다. GPU /ocr 의 줄(글·점수·위치)을 기준 화면의 줄과 견준다.
// 바뀐 영역(렌더러 감지기가 정함)과 겹치는 새 줄만 남겨, 영역 밖 OCR 흔들림("2,318"↔"2.318")과
// 앞 사건에서 기준이 갱신되지 않아 남은 줄을 막는다.
const { SCREEN_TEXT_CONFIDENT_SCORE } = require('./screen-text-grounding');

const SCREEN_TEXT_DIFF_KIND_MAP = {
  newText: 'new_text',
  // 새 줄은 없지만 바뀐 영역이 기준 글자 줄과 겹친다(색칠·테두리·체크로 답을 공개하는 꼴).
  highlight: 'highlight',
  // 글자 변화도, 겹치는 글자도 없다(사진·도형·라벨 없는 차트).
  visual: 'visual',
};

const SCREEN_TEXT_DIFF_SKIP_MAP = {
  // 기준 없이 화면 전체를 새 글자로 보면 슬라이드 전체를 읽게 된다.
  baselineMissing: 'baseline_missing',
  scroll: 'scroll',
};

const REGION_MARGIN = 0.05;
// 맞춰진 줄의 세로 이동 중앙값이 화면 높이의 이 비율을 넘고 방향이 한결같으면 스크롤이다.
const SCROLL_MIN_SHIFT_RATIO = 0.01;
const SCROLL_MIN_MATCHED_LINE_COUNT = 2;

// 공백·문장부호를 빼고 소문자로, 숫자의 천 단위 쉼표를 뗀다. 소수점·퍼센트·부호는 값이 달라지므로 남긴다.
function normalizeOcrLineText(text) {
  return String(text || '').toLowerCase()
    .replace(/(\d)[,，](?=\d)/g, '$1')
    .replace(/[^\p{L}\p{N}%.+-]/gu, '')
    .replace(/(?<!\d)\.|\.(?!\d)/g, '')
    .replace(/-(?!\d)/g, '');
}

function isConfidentLine(line) {
  if (typeof line?.text !== 'string' || !normalizeOcrLineText(line.text)) return false;
  return !Number.isFinite(line.score) || line.score >= SCREEN_TEXT_CONFIDENT_SCORE;
}

function toLineBox({ line, imageWidth, imageHeight }) {
  const hasGeometry = [line.left, line.top, line.width, line.height].every(Number.isFinite)
    && imageWidth > 0 && imageHeight > 0;
  if (!hasGeometry) return null;
  return {
    x: line.left / imageWidth, y: line.top / imageHeight, w: line.width / imageWidth, h: line.height / imageHeight,
  };
}

function isOverlapping(boxA, boxB) {
  return boxA.x < boxB.x + boxB.w && boxB.x < boxA.x + boxA.w
    && boxA.y < boxB.y + boxB.h && boxB.y < boxA.y + boxA.h;
}

function expandRegion(regionNorm, margin) {
  return {
    x: regionNorm.x - margin, y: regionNorm.y - margin, w: regionNorm.w + margin * 2, h: regionNorm.h + margin * 2,
  };
}

// 위치를 알 수 없는 줄은 영역과 견줄 수 없어 겹친다고 본다.
function isLineInRegion({ line, imageWidth, imageHeight, region }) {
  if (!region) return true;
  const box = toLineBox({ line, imageWidth, imageHeight });
  return !box || isOverlapping(box, region);
}

function median(valueList) {
  const sorted = [...valueList].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isScrolledLineSet(shiftRatioList) {
  if (shiftRatioList.length < SCROLL_MIN_MATCHED_LINE_COUNT) return false;
  const middleShift = median(shiftRatioList);
  if (Math.abs(middleShift) <= SCROLL_MIN_SHIFT_RATIO) return false;
  return shiftRatioList.every((shift) => Math.abs(shift) <= SCROLL_MIN_SHIFT_RATIO || Math.sign(shift) === Math.sign(middleShift));
}

// baseline·current: { lineList, imageWidth, imageHeight }. regionNorm: 바뀐 영역(0~1 비율). 없으면 화면 전체를 본다.
// regionLineList 는 지금 화면에서 바뀐 영역에 걸친 줄이다(강조된 항목 이름을 VLM 에 알려 줄 때 쓴다).
function diffScreenText({ baseline, current, regionNorm = null, regionMargin = REGION_MARGIN }) {
  const empty = { addedLineList: [], regionLineList: [], addedLineCountTotal: 0, removedLineCount: 0, matchedLineCount: 0 };
  if (!baseline || !Array.isArray(baseline.lineList)) {
    return { ...empty, kind: null, skipReason: SCREEN_TEXT_DIFF_SKIP_MAP.baselineMissing };
  }
  const baseLineList = baseline.lineList.filter(isConfidentLine);
  const currentLineList = (current?.lineList || []).filter(isConfidentLine);
  const queueByKeyMap = new Map();
  for (const line of baseLineList) {
    const key = normalizeOcrLineText(line.text);
    if (!queueByKeyMap.has(key)) queueByKeyMap.set(key, []);
    queueByKeyMap.get(key).push(line);
  }
  const addedAllList = [];
  const shiftRatioList = [];
  for (const line of currentLineList) {
    const queue = queueByKeyMap.get(normalizeOcrLineText(line.text));
    const matched = queue?.shift();
    if (!matched) { addedAllList.push(line); continue; }
    if (Number.isFinite(matched.top) && Number.isFinite(line.top) && current.imageHeight > 0 && baseline.imageHeight > 0) {
      shiftRatioList.push(line.top / current.imageHeight - matched.top / baseline.imageHeight);
    }
  }
  const removedLineCount = [...queueByKeyMap.values()].reduce((sum, queue) => sum + queue.length, 0);
  const matchedLineCount = currentLineList.length - addedAllList.length;
  const counts = { addedLineCountTotal: addedAllList.length, removedLineCount, matchedLineCount };
  if (isScrolledLineSet(shiftRatioList)) {
    return { ...empty, ...counts, kind: null, skipReason: SCREEN_TEXT_DIFF_SKIP_MAP.scroll };
  }
  const region = regionNorm ? expandRegion(regionNorm, regionMargin) : null;
  const isInRegion = (line) => isLineInRegion({ line, imageWidth: current.imageWidth, imageHeight: current.imageHeight, region });
  const trimText = (line) => ({ ...line, text: line.text.trim() });
  const addedLineList = addedAllList.filter(isInRegion).map(trimText);
  const regionLineList = region ? currentLineList.filter(isInRegion).map(trimText) : [];
  if (addedLineList.length) {
    return { ...counts, addedLineList, regionLineList, kind: SCREEN_TEXT_DIFF_KIND_MAP.newText, skipReason: null };
  }
  const isOverBaseText = Boolean(region) && baseLineList.some((line) => {
    const box = toLineBox({ line, imageWidth: baseline.imageWidth, imageHeight: baseline.imageHeight });
    return box && isOverlapping(box, region);
  });
  return {
    ...counts, addedLineList: [], regionLineList,
    kind: isOverBaseText ? SCREEN_TEXT_DIFF_KIND_MAP.highlight : SCREEN_TEXT_DIFF_KIND_MAP.visual,
    skipReason: null,
  };
}

module.exports = {
  diffScreenText, normalizeOcrLineText, isConfidentLine, SCREEN_TEXT_DIFF_KIND_MAP, SCREEN_TEXT_DIFF_SKIP_MAP,
  REGION_MARGIN,
};
