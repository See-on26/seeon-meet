// 공유 화면의 세로 막대그래프에서 막대 값을 어림한다. 세로축 눈금은 서버 OCR 줄 위치로, 막대 윗변은 화소로 찾는다.
// 세로 막대·한 계열·값 라벨 없는 그래프만 다룬다. 서버 OCR 이 줄 단위라 같은 높이의 글자(x 축 범주 라벨·가로 눈금)는
// 한 줄로 이어져 낱말별 x 위치가 없으므로, 꺾은선·가로 막대는 다루지 않는다.
// 틀린 어림을 사실처럼 말하는 것이 가장 나쁘므로 조금이라도 애매하면 건너뛴다(어림값을 넘기지 않는다).
// 색 거리와 사영만 쓰므로 화소 채널 순서(RGBA·BGRA)와 상관없다.

const CHART_STATUS_MAP = { ok: 'ok', skip: 'skip' };
const CHART_SKIP_REASON_MAP = {
  noDecoder: 'no_decoder',
  ocrUnusable: 'ocr_unusable',
  noAxis: 'no_axis',
  multipleAxes: 'multiple_axes',
  barCount: 'bar_count',
  offBaselineBar: 'off_baseline_bar',
  nonUniformBar: 'non_uniform_bar',
  unevenSpacing: 'uneven_spacing',
  valueLabels: 'value_labels',
  categoryMismatch: 'category_mismatch',
  outOfRange: 'out_of_range',
  decodeError: 'decode_error',
  error: 'error',
};

// 눈금 글자: 부호, 통화 기호, 천 단위 쉼표, 소수, 뒤에 붙는 단위 두 글자까지. 숫자 사이 띄어쓰기는 다른 글자다("2015 2016").
const TICK_PATTERN = /^([-−]?)([$₩€£¥]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|[A-Za-z가-힣]{0,2})$/;
// 날짜·순서를 뜻하는 꼬리는 눈금 단위가 아니다("2019년", "3월", "2분기", "1위"). 표의 연도 열·순위 열이 축으로 잡히지 않게 한다.
const NON_TICK_UNIT_PATTERN = /^(?:년|월|일|분기|위|차|회|번|호|층)$/;
// 1900~2100 의 정수만으로 된 세로 숫자 열은 연도 열로 본다.
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;
const MIN_TICK_SCORE = 0.85;
const MIN_AXIS_TICK_COUNT = 3;
const MAX_FIT_RESIDUAL_RATIO = 0.02;
// 눈금 값 간격은 한 간격의 정수배여야 한다(눈금 하나를 빼고 맞춘 경우 두 배 간격이 생긴다).
const STEP_MULTIPLE_TOLERANCE = 0.02;
const MAX_STEP_MULTIPLE = 3;
// 화소 없이 줄만 볼 때의 그림 폭. 프레임은 긴 변 1280 이하다.
const PROBE_FRAME_WIDTH = 1280;
// 배경과 이만큼(L1, 세 채널 합) 넘게 다르면 잉크로 본다.
const INK_DISTANCE = 60;
const GRIDLINE_INK_DISTANCE = 24;
const MIN_BAR_HEIGHT_PX = 4;
const MIN_BAR_COUNT = 2;
const MAX_BAR_COUNT = 24;
const MIN_UNIFORMITY = 0.75;
const MAX_EDGE_SPREAD_PX = 2;
const MAX_SPACING_CV = 0.15;
const GRIDLINE_MIN_ROW_INK = 0.6;
// 눈금선은 얇은 줄이라 위아래 몇 줄보다 잉크가 뚜렷이 많아야 한다(막대 윗변처럼 한쪽만 꺼지는 줄은 눈금선이 아니다).
const GRIDLINE_MIN_PEAK_GAIN = 0.25;
const GRIDLINE_MIN_SNAP_RATIO = 0.7;
const GRIDLINE_MAX_FIT_RESIDUAL_RATIO = 0.01;
const VALUE_LABEL_REACH_LINE_HEIGHT = 2.5;
const CATEGORY_REACH_LINE_HEIGHT = 2.5;

function parseTickNumber(text) {
  const match = String(text || '').trim().match(TICK_PATTERN);
  if (!match) return null;
  const suffix = match[5] || '';
  if (NON_TICK_UNIT_PATTERN.test(suffix)) return null;
  const value = Number(`${match[3].replace(/,/g, '')}${match[4] || ''}`) * (match[1] ? -1 : 1);
  return Number.isFinite(value) ? { value, unit: `${match[2]}${suffix}` } : null;
}

const median = (list) => {
  const sorted = [...list].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

function fitLine(pointList) {
  const count = pointList.length;
  const meanX = pointList.reduce((sum, point) => sum + point.x, 0) / count;
  const meanY = pointList.reduce((sum, point) => sum + point.y, 0) / count;
  let sxx = 0;
  let sxy = 0;
  for (const point of pointList) {
    sxx += (point.x - meanX) ** 2;
    sxy += (point.x - meanX) * (point.y - meanY);
  }
  const slope = sxx ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  const residualList = pointList.map((point) => Math.abs(point.y - (intercept + slope * point.x)));
  return { slope, intercept, residualList };
}

function clusterBy(itemList, key, tolerance) {
  const sortedList = [...itemList].sort((left, right) => left[key] - right[key]);
  const clusterList = [];
  for (const item of sortedList) {
    const last = clusterList[clusterList.length - 1];
    if (last && Math.abs(item[key] - last[last.length - 1][key]) <= tolerance) last.push(item);
    else clusterList.push([item]);
  }
  return clusterList;
}

function readTickCandidateList(lineList) {
  return (Array.isArray(lineList) ? lineList : []).map((line) => {
    if (typeof line?.text !== 'string' || ![line.left, line.top, line.width, line.height].every(Number.isFinite)) return null;
    if (Number.isFinite(line.score) && line.score < MIN_TICK_SCORE) return null;
    const parsed = parseTickNumber(line.text);
    if (!parsed) return null;
    return {
      ...parsed, line, cy: line.top + line.height / 2, right: line.left + line.width, cx: line.left + line.width / 2,
    };
  }).filter(Boolean);
}

// 위에서 아래로 늘어선 눈금 값이 한 간격의 정수배로만 벌어지는가.
function hasRegularStep(valueList) {
  const stepList = valueList.slice(1).map((value, index) => Math.abs(valueList[index] - value));
  if (!stepList.length || stepList.some((step) => step <= 0)) return false;
  const baseStep = Math.min(...stepList);
  return stepList.every((step) => {
    const multiple = step / baseStep;
    return Math.round(multiple) <= MAX_STEP_MULTIPLE && Math.abs(multiple - Math.round(multiple)) <= STEP_MULTIPLE_TOLERANCE;
  });
}

const isYearColumn = (valueList) => valueList.every((value) => Number.isInteger(value) && value >= YEAR_MIN && value <= YEAR_MAX);

function fitAxisCluster(cluster) {
  let memberList = [...cluster].sort((left, right) => left.cy - right.cy);
  // 한 번 맞춰 보고 안 되면 잔차가 가장 큰 눈금 하나를 빼고 다시 맞춘다("400"을 "40"으로 잘못 읽은 경우).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fit = fitLine(memberList.map((tick) => ({ x: tick.cy, y: tick.value })));
    const valueList = memberList.map((tick) => tick.value);
    const valueRange = Math.max(...valueList) - Math.min(...valueList);
    const maxResidual = Math.max(...fit.residualList);
    if (fit.slope < 0 && valueRange > 0 && maxResidual <= MAX_FIT_RESIDUAL_RATIO * valueRange
      && hasRegularStep(valueList) && !isYearColumn(valueList)) {
      return { memberList, ...fit, valueRange };
    }
    if (memberList.length <= MIN_AXIS_TICK_COUNT) return null;
    const worstIndex = fit.residualList.indexOf(maxResidual);
    memberList = memberList.filter((_, index) => index !== worstIndex);
  }
  return null;
}

// 숫자만으로 된 줄을 오른쪽 끝(오른쪽 맞춤 눈금) 또는 가운데로 묶어, 값 = a + b·cy 가 곧게 맞는 무리를 세로축으로 본다.
function findYAxis({ lineList, width = PROBE_FRAME_WIDTH }) {
  const tickList = readTickCandidateList(lineList);
  const tolerance = Math.max(6, 0.006 * width);
  const fittedList = [];
  for (const key of ['right', 'cx']) {
    for (const cluster of clusterBy(tickList, key, tolerance)) {
      if (cluster.length < MIN_AXIS_TICK_COUNT) continue;
      const fitted = fitAxisCluster(cluster);
      if (fitted) fittedList.push(fitted);
    }
  }
  if (!fittedList.length) return { skipReason: CHART_SKIP_REASON_MAP.noAxis };
  // 같은 줄 무리를 오른쪽 끝·가운데로 두 번 찾았을 수 있다 — 겹치는 무리는 하나로 본다.
  const uniqueList = [];
  for (const fitted of fittedList.sort((left, right) => right.memberList.length - left.memberList.length)) {
    const isDuplicate = uniqueList.some((kept) => fitted.memberList.some((tick) => kept.memberList.includes(tick)));
    if (!isDuplicate) uniqueList.push(fitted);
  }
  if (uniqueList.length > 1) return { skipReason: CHART_SKIP_REASON_MAP.multipleAxes };
  const [fitted] = uniqueList;
  const valueList = fitted.memberList.map((tick) => tick.value);
  const stepList = valueList.slice(1).map((value, index) => Math.abs(valueList[index] - value));
  const unitCountMap = new Map();
  for (const tick of fitted.memberList) if (tick.unit) unitCountMap.set(tick.unit, (unitCountMap.get(tick.unit) || 0) + 1);
  const unit = [...unitCountMap.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || '';
  return {
    axis: {
      slope: fitted.slope,
      intercept: fitted.intercept,
      step: Math.min(...stepList),
      valueRange: fitted.valueRange,
      minValue: Math.min(...valueList),
      maxValue: Math.max(...valueList),
      tickList: fitted.memberList.map((tick) => ({ value: tick.value, cy: tick.cy })),
      memberLineList: fitted.memberList.map((tick) => tick.line),
      right: Math.max(...fitted.memberList.map((tick) => tick.right)),
      lineHeight: median(fitted.memberList.map((tick) => tick.line.height)),
      unit,
      minCy: Math.min(...fitted.memberList.map((tick) => tick.cy)),
      maxCy: Math.max(...fitted.memberList.map((tick) => tick.cy)),
      isSnapped: false,
    },
  };
}

function hasAxisCandidate({ lineList, width = PROBE_FRAME_WIDTH }) {
  return Boolean(findYAxis({ lineList, width }).axis);
}

function readPixel(bitmap, x, y) {
  const index = (y * bitmap.width + x) * 4;
  return [bitmap.data[index], bitmap.data[index + 1], bitmap.data[index + 2]];
}

const colorDistance = (left, right) => Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]) + Math.abs(left[2] - right[2]);

// 영역에서 가장 흔한 색(4비트로 묶은 칸 중 가장 많은 칸의 평균).
function readModeColor(bitmap, x0, y0, x1, y1) {
  const { data, width } = bitmap;
  const countList = new Uint32Array(4096);
  const sumList = new Float64Array(4096 * 3);
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const index = (y * width + x) * 4;
      const key = ((data[index] >> 4) << 8) | ((data[index + 1] >> 4) << 4) | (data[index + 2] >> 4);
      countList[key] += 1;
      sumList[key * 3] += data[index]; sumList[key * 3 + 1] += data[index + 1]; sumList[key * 3 + 2] += data[index + 2];
    }
  }
  let bestKey = -1;
  for (let key = 0; key < 4096; key += 1) if (countList[key] && (bestKey < 0 || countList[key] > countList[bestKey])) bestKey = key;
  if (bestKey < 0) return [255, 255, 255];
  return [0, 1, 2].map((channel) => sumList[bestKey * 3 + channel] / countList[bestKey]);
}

const readPlotLeft = ({ bitmap, axis }) => Math.min(bitmap.width - 1, Math.round(axis.right + Math.max(4, 0.005 * bitmap.width)));

// 눈금 줄 높이 근처에 그림 폭을 가로지르는 얇은 줄(눈금선)이 있으면 그 줄에 눈금 위치를 맞춘다.
// OCR 상자의 위아래 흔들림과, 라벨을 눈금선 위에 얹는 양식의 어긋남이 함께 사라진다.
function snapTicksToGridlines({ bitmap, axis }) {
  const x0 = readPlotLeft({ bitmap, axis });
  const x1 = Math.min(bitmap.width - 2, x0 + Math.round(0.4 * bitmap.width));
  if (x1 - x0 < 10) return { ...axis, isSnapped: false };
  const background = readModeColor(bitmap, x0, Math.round(axis.minCy), x1, Math.round(axis.maxCy));
  const readRowInk = (y) => {
    if (y < 0 || y >= bitmap.height) return 0;
    let inkCount = 0;
    let totalCount = 0;
    for (let x = x0; x < x1; x += 3) {
      totalCount += 1;
      if (colorDistance(readPixel(bitmap, x, y), background) > GRIDLINE_INK_DISTANCE) inkCount += 1;
    }
    return inkCount / totalCount;
  };
  const reach = Math.max(3, Math.round(0.6 * axis.lineHeight));
  const snappedList = axis.tickList.map((tick) => {
    let best = null;
    const center = Math.round(tick.cy);
    for (let y = Math.max(1, center - reach); y <= Math.min(bitmap.height - 2, center + reach); y += 1) {
      const ink = readRowInk(y);
      const isPeak = ink - Math.max(readRowInk(y - 3), readRowInk(y + 3)) >= GRIDLINE_MIN_PEAK_GAIN;
      if (ink >= GRIDLINE_MIN_ROW_INK && isPeak && (!best || ink > best.ink)) best = { y, ink };
    }
    return best ? { ...tick, cy: best.y } : null;
  });
  const keptList = snappedList.filter(Boolean);
  if (keptList.length < Math.max(MIN_AXIS_TICK_COUNT, Math.ceil(GRIDLINE_MIN_SNAP_RATIO * snappedList.length))) {
    return { ...axis, isSnapped: false };
  }
  const fit = fitLine(keptList.map((tick) => ({ x: tick.cy, y: tick.value })));
  if (!(fit.slope < 0) || Math.max(...fit.residualList) > GRIDLINE_MAX_FIT_RESIDUAL_RATIO * axis.valueRange) {
    return { ...axis, isSnapped: false };
  }
  return {
    ...axis, slope: fit.slope, intercept: fit.intercept, isSnapped: true,
    tickList: axis.tickList.map((tick, index) => snappedList[index] || tick),
  };
}

function readScanWindow({ bitmap, axis }) {
  const spacing = (axis.maxCy - axis.minCy) / Math.max(1, axis.tickList.length - 1);
  return {
    x0: readPlotLeft({ bitmap, axis }),
    x1: bitmap.width - 2,
    y0: Math.max(0, Math.round(axis.minCy - 0.6 * spacing)),
    y1: Math.min(bitmap.height - 1, Math.round(axis.maxCy + 0.6 * spacing)),
  };
}

// 열마다 배경과 다른 화소가 가장 길게 이어진 구간을 찾고, 바닥이 ±3px 안에서 같은 이웃 열을 이어 막대 후보로 묶는다.
// 폭이 좁은 것(축선·눈금선·글자 획)은 빠진다.
function detectVerticalBars({ bitmap, axis }) {
  const { x0, x1, y0, y1 } = readScanWindow({ bitmap, axis });
  const background = readModeColor(bitmap, x0, y0, x1, y1);
  // 잉크 표시는 줄 순서로 한 번에 만든다(화소를 줄 순서로 읽어야 빠르다). 열 훑기는 이 표시만 본다.
  const windowWidth = Math.max(0, x1 - x0);
  const inkMask = new Uint8Array(windowWidth * (y1 - y0 + 1));
  const { data, width } = bitmap;
  for (let y = y0; y <= y1; y += 1) {
    const rowOffset = (y - y0) * windowWidth;
    for (let x = x0; x < x1; x += 1) {
      const index = (y * width + x) * 4;
      const distance = Math.abs(data[index] - background[0]) + Math.abs(data[index + 1] - background[1])
        + Math.abs(data[index + 2] - background[2]);
      inkMask[rowOffset + x - x0] = distance > INK_DISTANCE ? 1 : 0;
    }
  }
  const columnList = [];
  for (let x = x0; x < x1; x += 1) {
    let best = null;
    let runStart = null;
    for (let y = y0; y <= y1; y += 1) {
      const isInk = inkMask[(y - y0) * windowWidth + x - x0] === 1;
      if (isInk && runStart === null) runStart = y;
      if ((!isInk || y === y1) && runStart !== null) {
        const end = isInk ? y : y - 1;
        if (!best || end - runStart > best.end - best.start) best = { start: runStart, end };
        runStart = null;
      }
    }
    columnList.push(best && best.end - best.start + 1 >= MIN_BAR_HEIGHT_PX ? { x, ...best } : null);
  }
  const runList = [];
  let current = null;
  for (const column of columnList) {
    if (column && current && Math.abs(column.end - current.bottom) <= 3) {
      current.columnList.push(column);
      continue;
    }
    if (current) runList.push(current);
    current = column ? { columnList: [column], bottom: column.end } : null;
  }
  if (current) runList.push(current);
  const minWidth = Math.max(5, Math.round(0.006 * bitmap.width));
  const candidateList = runList.filter((run) => run.columnList.length >= minWidth).map((run) => {
    const centerColumnList = run.columnList.slice(Math.floor(run.columnList.length * 0.25), Math.ceil(run.columnList.length * 0.75));
    const xa = run.columnList[0].x;
    const xb = run.columnList[run.columnList.length - 1].x;
    return {
      xa, xb, cx: (xa + xb) / 2, width: xb - xa + 1, centerColumnList,
      start: median(centerColumnList.map((column) => column.start)),
      bottom: median(centerColumnList.map((column) => column.end)),
    };
  });
  return { candidateList, background, scanTop: y0 };
}

// 막대 윗변: 가운데 열마다 바닥에서 위로 올라가며 막대색 쪽 사영이 0.5 이상인 줄을 잇는다. 3줄 넘게 이어진 조각만 막대로 치고
// (1px 눈금선은 막대가 아니다), 조각 사이 틈은 막대 안 글자 높이(1.5줄)까지 건넌다. 그 위의 제목·범례는 틈이 길어 붙지 않는다.
// 바로 위 줄의 사영값으로 부분 화소까지 잇는다. 고름은 윗변부터 바닥까지 막대색과 가까운 화소 비율이다
// (사영만 보면 누적 막대의 다른 색 칸도 막대로 친다).
const MIN_BAR_SEGMENT_ROWS = 3;
const INSIDE_PROJECTION = 0.5;

function findBarTopRow({ project, bottom, scanTop, maxGapRows }) {
  let top = null;
  let segmentStart = null;
  let gapRows = 0;
  for (let y = bottom; y >= scanTop - 1; y -= 1) {
    const isInside = y >= scanTop && project(y) >= INSIDE_PROJECTION;
    if (isInside) {
      if (segmentStart === null) segmentStart = y;
      continue;
    }
    if (segmentStart !== null) {
      const segmentRows = segmentStart - y;
      const touchesBottom = segmentStart >= bottom - 2;
      if (segmentRows >= MIN_BAR_SEGMENT_ROWS || touchesBottom) {
        top = y + 1;
        gapRows = 0;
      } else {
        gapRows += segmentRows;
      }
      segmentStart = null;
    }
    gapRows += 1;
    if (top !== null && gapRows > maxGapRows) break;
  }
  return top;
}

function measureBar({ bitmap, candidate, background, scanTop, lineHeight }) {
  const sampleY = Math.round(candidate.bottom - 0.25 * (candidate.bottom - candidate.start));
  const color = [0, 1, 2].map((channel) => median(candidate.centerColumnList.map((column) => readPixel(bitmap, column.x, sampleY)[channel])));
  if (colorDistance(color, background) < INK_DISTANCE) return null;
  const direction = color.map((value, channel) => value - background[channel]);
  const directionNorm = direction.reduce((sum, value) => sum + value * value, 0);
  const maxGapRows = Math.max(6, Math.round(1.5 * lineHeight));
  const edgeList = [];
  let uniformCount = 0;
  let totalCount = 0;
  for (const column of candidate.centerColumnList) {
    const project = (y) => {
      const pixel = readPixel(bitmap, column.x, y);
      return pixel.reduce((sum, value, channel) => sum + (value - background[channel]) * direction[channel], 0) / directionNorm;
    };
    const topRow = findBarTopRow({ project, bottom: candidate.bottom, scanTop, maxGapRows });
    if (topRow === null) return null;
    const aboveRatio = topRow > 0 ? Math.max(0, Math.min(1, project(topRow - 1))) : 0;
    edgeList.push(topRow - aboveRatio);
    for (let y = topRow; y <= candidate.bottom; y += 1) {
      totalCount += 1;
      if (colorDistance(readPixel(bitmap, column.x, y), color) <= INK_DISTANCE) uniformCount += 1;
    }
  }
  if (!edgeList.length) return null;
  const top = median(edgeList);
  if (Math.max(...edgeList) - Math.min(...edgeList) > MAX_EDGE_SPREAD_PX) return null;
  if (candidate.bottom - top < MIN_BAR_HEIGHT_PX) return null;
  return { ...candidate, top, color, uniformity: uniformCount / totalCount };
}

const hasDigit = (text) => /\d/.test(String(text || ''));

// 눈금 줄을 뺀 숫자 든 줄이 어느 막대의 x 범위(±반 폭)와 겹치고 윗변 조금 위부터 바닥 사이에 있으면 값 라벨로 본다.
// 일부 막대에만 붙어 있어도, 막대 안에 있어도 값 라벨이다.
function findValueLabelLine({ lineList, axis, barList }) {
  return lineList.find((line) => {
    if (!hasDigit(line?.text) || axis.memberLineList.includes(line)) return false;
    const lineBottom = line.top + line.height;
    return barList.some((bar) => {
      const halfWidth = (bar.xb - bar.xa) / 2;
      return line.left <= bar.xb + halfWidth && line.left + line.width >= bar.xa - halfWidth
        && lineBottom >= bar.top - VALUE_LABEL_REACH_LINE_HEIGHT * axis.lineHeight && line.top <= bar.bottom - 2;
    });
  }) || null;
}

// 바닥선 바로 아래 줄을 범주 이름으로 본다. 낱말 수가 막대 수와 같을 때만 순서대로 이름을 붙인다.
// 줄이 없으면 이름 없이(왼쪽부터 순서로) 넘기고, 낱말 수가 다르면 건너뛴다("20대 남성"처럼 띄어 쓴 이름, 묶음 막대).
function assignCategoryList({ lineList, axis, barList }) {
  const base = median(barList.map((bar) => bar.bottom));
  const firstBar = barList[0];
  const lastBar = barList[barList.length - 1];
  const categoryLine = lineList.find((line) => !axis.memberLineList.includes(line)
    && line.top >= base - 2 && line.top <= base + CATEGORY_REACH_LINE_HEIGHT * axis.lineHeight
    && line.left < lastBar.xb && line.left + line.width > firstBar.xa);
  if (!categoryLine) return { categoryList: null };
  const tokenList = categoryLine.text.trim().split(/\s+/).filter(Boolean);
  if (tokenList.length !== barList.length) return { skipReason: CHART_SKIP_REASON_MAP.categoryMismatch };
  return { categoryList: tokenList };
}

function roundToNice(value) {
  const power = 10 ** Math.floor(Math.log10(value));
  const mantissa = value / power;
  const nice = mantissa < 1.5 ? 1 : mantissa < 3.5 ? 2 : mantissa < 7.5 ? 5 : 10;
  return Number((nice * power).toPrecision(12));
}

// 반올림 단위: 눈금 간격의 1/20 과 2화소에 해당하는 값 중 큰 쪽(1·2·5×10ⁿ). 0~1,000 축(간격 200)이면 10 단위.
function computeGranularity({ step, pixelValue }) {
  return Math.max(roundToNice(step / 20), roundToNice(2 * pixelValue));
}

function skip(skipReason, extra = {}) {
  return { status: CHART_STATUS_MAP.skip, skipReason, ...extra };
}

function estimateChartValues({ bitmap, lineList }) {
  const safeLineList = Array.isArray(lineList) ? lineList : [];
  const found = findYAxis({ lineList: safeLineList, width: bitmap.width });
  if (!found.axis) return skip(found.skipReason);
  const axis = snapTicksToGridlines({ bitmap, axis: found.axis });
  const { candidateList, background, scanTop } = detectVerticalBars({ bitmap, axis });
  if (!candidateList.length) return skip(CHART_SKIP_REASON_MAP.barCount, { barCount: 0 });
  // 바닥선(0 눈금이 있으면 그 높이, 없으면 바닥들의 중앙값)에 붙은 후보만 막대로 본다. 범례 네모·글 덩어리가 여기서 빠진다.
  const zeroTick = axis.tickList.find((tick) => tick.value === 0);
  const base = zeroTick ? zeroTick.cy : median(candidateList.map((candidate) => candidate.bottom));
  const baseTolerance = Math.max(4, 0.6 * axis.lineHeight);
  const onBaseList = candidateList.filter((candidate) => Math.abs(candidate.bottom - base) <= baseTolerance);
  if (onBaseList.length < MIN_BAR_COUNT || onBaseList.length > MAX_BAR_COUNT) {
    return skip(CHART_SKIP_REASON_MAP.barCount, { barCount: onBaseList.length });
  }
  // 바닥선에서 아래로 내려간 막대 폭의 후보가 있으면 음수 막대가 섞인 그래프다. 위쪽 막대만 읽으면 순서가 어긋난다.
  const medianWidth = median(onBaseList.map((candidate) => candidate.width));
  const hasHangingBar = candidateList.some((candidate) => !onBaseList.includes(candidate)
    && Math.abs(candidate.start - base) <= baseTolerance && candidate.bottom > base + baseTolerance
    && candidate.width >= 0.6 * medianWidth);
  if (hasHangingBar) return skip(CHART_SKIP_REASON_MAP.offBaselineBar, { barCount: onBaseList.length });
  // 값 라벨은 윗변 바로 위·안에 붙어 윗변 찾기를 흐트러뜨리므로, 윗변을 재기 전에 후보의 잉크 시작 높이로 먼저 본다.
  const roughBarList = onBaseList.map((candidate) => ({ ...candidate, top: candidate.start }));
  if (findValueLabelLine({ lineList: safeLineList, axis, barList: roughBarList })) {
    return skip(CHART_SKIP_REASON_MAP.valueLabels, { barCount: onBaseList.length });
  }
  const barList = [];
  for (const candidate of onBaseList.sort((left, right) => left.cx - right.cx)) {
    const bar = measureBar({ bitmap, candidate, background, scanTop, lineHeight: axis.lineHeight });
    if (!bar || bar.uniformity < MIN_UNIFORMITY) return skip(CHART_SKIP_REASON_MAP.nonUniformBar, { barCount: onBaseList.length });
    barList.push(bar);
  }
  // 막대 간격이 고르지 않으면(묶음 막대·떠 있는 막대) 순서로 이름을 붙일 수 없다.
  const gapList = barList.slice(1).map((bar, index) => bar.cx - barList[index].cx);
  if (gapList.length >= 2) {
    const meanGap = gapList.reduce((sum, gap) => sum + gap, 0) / gapList.length;
    const deviation = Math.sqrt(gapList.reduce((sum, gap) => sum + (gap - meanGap) ** 2, 0) / gapList.length);
    if (deviation / meanGap > MAX_SPACING_CV) return skip(CHART_SKIP_REASON_MAP.unevenSpacing, { barCount: barList.length });
  }
  const category = assignCategoryList({ lineList: safeLineList, axis, barList });
  if (category.skipReason) return skip(category.skipReason, { barCount: barList.length });
  const granularity = computeGranularity({ step: axis.step, pixelValue: Math.abs(axis.slope) });
  const decimalCount = Math.max(0, -Math.floor(Math.log10(granularity)));
  const lowerLimit = axis.minValue - axis.step / 2;
  const upperLimit = axis.maxValue + axis.step / 2;
  const valueList = barList.map((bar, index) => {
    const raw = axis.intercept + axis.slope * bar.top;
    return {
      label: category.categoryList ? category.categoryList[index] : null,
      value: Number((Math.round(raw / granularity) * granularity).toFixed(decimalCount)),
      raw,
    };
  });
  if (valueList.some((entry) => entry.raw < lowerLimit || entry.raw > upperLimit)) {
    return skip(CHART_SKIP_REASON_MAP.outOfRange, { barCount: barList.length });
  }
  return {
    status: CHART_STATUS_MAP.ok,
    skipReason: null,
    barCount: barList.length,
    valueList,
    granularity,
    isSnapped: axis.isSnapped,
    unit: axis.unit,
    tickMin: axis.minValue,
    tickMax: axis.maxValue,
    step: axis.step,
    tickValueList: axis.tickList.map((tick) => tick.value).sort((left, right) => left - right),
  };
}

const readNow = () => performance.now();
const roundMs = (value) => Math.round(value * 10) / 10;

// 줄만 보는 사전 검사 → 그림 풀기 → 어림. 축 후보가 없는 화면은 그림을 풀지 않는다.
// decoder 가 없으면(Electron 밖) no_decoder 로 건너뛴다. 걸린 시간(풀기·분석)을 함께 돌려준다.
// saveFrame 이 있으면 그림을 풀어 어림한 프레임을 남기고(사람이 나중에 어림값을 눈으로 확인) 그 경로를 결과에 붙인다.
function createChartEstimator({ decoder = null, saveFrame = null, now = readNow }) {
  function estimate({ jpegBuffer, lineList, frameTag = null }) {
    const base = { decodeMs: null, estimateMs: null, isDecoded: false };
    const probe = findYAxis({ lineList, width: PROBE_FRAME_WIDTH });
    if (!probe.axis) return { ...skip(probe.skipReason), ...base };
    if (!decoder) return { ...skip(CHART_SKIP_REASON_MAP.noDecoder), ...base };
    const decodeStartedAt = now();
    let bitmap = null;
    try {
      bitmap = decoder.decode(jpegBuffer);
    } catch {
      bitmap = null;
    }
    const decodeMs = roundMs(now() - decodeStartedAt);
    if (!bitmap) return { ...skip(CHART_SKIP_REASON_MAP.decodeError), ...base, decodeMs };
    const estimateStartedAt = now();
    const result = estimateChartValues({ bitmap, lineList });
    const estimateMs = roundMs(now() - estimateStartedAt);
    const framePath = saveFrame && frameTag ? saveFrame({ jpegBuffer, frameTag }) : null;
    return {
      ...result, decodeMs, estimateMs, isDecoded: true, imageWidth: bitmap.width, imageHeight: bitmap.height,
      ...(framePath ? { framePath } : {}),
    };
  }
  return { estimate };
}

const NUMBER_TOKEN_PATTERN = /\d+(?:[.,]\d+)*/g;

function readNumberList(text) {
  return (String(text || '').match(NUMBER_TOKEN_PATTERN) || [])
    .map((token) => Number(token.replace(/,/g, '')))
    .filter(Number.isFinite);
}

// 값 칸의 숫자가 눈금 값과 같고 모든 어림값과 반올림 단위 넘게 다르면, 막대를 가까운 눈금으로 반올림해 말한 것으로 의심한다("약 800").
// 동작은 바꾸지 않고 기록에만 남긴다.
function detectTickSnapSuspect({ value, chart }) {
  if (chart?.status !== CHART_STATUS_MAP.ok) return false;
  return readNumberList(value).some((number) => chart.tickValueList.includes(number)
    && chart.valueList.every((entry) => Math.abs(entry.raw - number) > chart.granularity));
}

// 값 검사가 쓰는 어림값 목록(원래 어림값과 반올림 단위).
function toChartValueList(chart) {
  if (chart?.status !== CHART_STATUS_MAP.ok) return [];
  return chart.valueList.map((entry) => ({ value: entry.value, raw: entry.raw, granularity: chart.granularity }));
}

// 기록에 남길 요약. 값은 반올림값과 원래 어림값(소수 둘째 자리)을 함께 둔다.
function summarizeChartResult(result) {
  if (!result) return null;
  const summary = {
    status: result.status, skipReason: result.skipReason ?? null,
    decodeMs: result.decodeMs ?? null, estimateMs: result.estimateMs ?? null,
  };
  if (result.errorMessage) summary.errorMessage = result.errorMessage;
  if (result.framePath) summary.framePath = result.framePath;
  if (Number.isFinite(result.barCount)) summary.barCount = result.barCount;
  if (Number.isFinite(result.imageWidth)) Object.assign(summary, { imageWidth: result.imageWidth, imageHeight: result.imageHeight });
  if (result.status !== CHART_STATUS_MAP.ok) return summary;
  return {
    ...summary,
    isSnapped: result.isSnapped, granularity: result.granularity, unit: result.unit,
    tickMin: result.tickMin, tickMax: result.tickMax, step: result.step,
    valueList: result.valueList.map((entry) => ({ label: entry.label, value: entry.value, raw: Math.round(entry.raw * 100) / 100 })),
  };
}

module.exports = {
  parseTickNumber, findYAxis, snapTicksToGridlines, detectVerticalBars, findValueLabelLine, assignCategoryList,
  computeGranularity, estimateChartValues, hasAxisCandidate, createChartEstimator, detectTickSnapSuspect, toChartValueList,
  summarizeChartResult, CHART_STATUS_MAP, CHART_SKIP_REASON_MAP,
};
