// 합성 세로 막대그래프와 서버 OCR 이 낼 줄 목록을 함께 만든다(그래프 어림 시험용).
// 서버 OCR 처럼 같은 높이의 글자는 한 줄로 잇는다(x 축 범주 라벨 = 한 줄). 윗변은 부분 화소로 섞고,
// 정해진 씨앗으로 ±6 잡음과 1px 흐림을 넣어 JPEG·영상 압축을 흉내 낸다. JPEG 을 풀지 않으므로 Electron 없이 돈다.

export const PALETTE = {
  blue: [52, 101, 164], orange: [230, 126, 34], green: [39, 174, 96], red: [231, 76, 60], gray: [127, 140, 141],
};

function createRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

export function createCanvas({ width, height, background = [255, 255, 255] }) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = background[0]; data[i * 4 + 1] = background[1]; data[i * 4 + 2] = background[2]; data[i * 4 + 3] = 255;
  }
  const blend = (x, y, color, alpha = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    for (let k = 0; k < 3; k += 1) data[i + k] = Math.round(data[i + k] * (1 - alpha) + color[k] * alpha);
  };
  // 윗변(y0)이 화소 사이에 걸치면 그 줄은 걸친 만큼만 섞는다(안티에일리어싱).
  const fillRect = (x0, y0, x1, y1, color) => {
    for (let x = Math.round(x0); x < Math.round(x1); x += 1) {
      const top = Math.floor(y0);
      blend(x, top, color, 1 - (y0 - top));
      for (let y = top + 1; y < Math.round(y1); y += 1) blend(x, y, color, 1);
    }
  };
  return { bitmap: { width, height, data }, blend, fillRect };
}

// 1px 상자 흐림과 ±amplitude 잡음.
export function degrade(bitmap, { seed = 1, amplitude = 6, blur = true } = {}) {
  const { width, height } = bitmap;
  const random = createRandom(seed);
  const source = blur ? Uint8Array.from(bitmap.data) : bitmap.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      for (let k = 0; k < 3; k += 1) {
        let value = source[i + k];
        if (blur) {
          let sum = 0; let count = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const xx = x + dx; const yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
              sum += source[(yy * width + xx) * 4 + k] * (dx === 0 && dy === 0 ? 4 : 1);
              count += dx === 0 && dy === 0 ? 4 : 1;
            }
          }
          value = sum / count;
        }
        const noisy = value + (random() - 0.5) * 2 * amplitude;
        bitmap.data[i + k] = Math.max(0, Math.min(255, Math.round(noisy)));
      }
    }
  }
  return bitmap;
}

function formatTick(value) {
  const rounded = Number(value.toFixed(4));
  return Math.abs(rounded) >= 1000 ? rounded.toLocaleString('en-US') : String(rounded);
}

// 세로 막대그래프 한 장. axis: { min, max, step, unit, labelList(눈금 글자를 직접 줄 때) }.
// plot 은 그림 영역(화소). 글자 모양은 진한 덩어리로 그리고, 줄 목록에는 그 위치와 글자를 넣는다.
export function drawBarChart({
  width = 1280, height = 720, axis = { min: 0, max: 1000, step: 200 }, valueList = [620, 680, 700, 740, 770],
  colorList = [PALETTE.blue], pale = false, gridlines = true, categoryList = null, categoryLine = true,
  valueLabels = null, insideText = false, legend = false, stacked = false, gradient = false, groupSize = 1,
  ocrJitterPx = 2, tickScore = 0.95, misreadTickMap = {}, seed = 7, noise = true,
  plot = { left: 200, right: 980, top: 120, bottom: 600 }, barRatio = 0.55, extraLineList = [], tickUnit = '',
  titleLine = true, baseValue = null,
} = {}) {
  const random = createRandom(seed);
  const canvas = createCanvas({ width, height });
  const { fillRect, blend } = canvas;
  const yOf = (value) => plot.bottom - ((value - axis.min) / (axis.max - axis.min)) * (plot.bottom - plot.top);
  const lineList = [];
  if (titleLine) {
    lineList.push({ text: '연도별 1인당 소비량', score: 0.97, left: 420, top: 40, width: 440, height: 40 });
    fillRect(420, 48, 860, 72, [40, 40, 40]);
  }
  const tickCount = Math.round((axis.max - axis.min) / axis.step);
  for (let k = 0; k <= tickCount; k += 1) {
    const value = axis.min + k * axis.step;
    const y = yOf(value);
    if (gridlines) for (let x = plot.left; x < plot.right; x += 1) blend(x, Math.round(y), [225, 225, 225]);
    const text = misreadTickMap[value] ?? `${formatTick(value)}${tickUnit}`;
    const textWidth = text.length * 11;
    fillRect(plot.left - 12 - textWidth, y - 7, plot.left - 12, y + 7, [90, 90, 90]);
    lineList.push({
      text, score: tickScore,
      left: Math.round(plot.left - 12 - textWidth + (random() - 0.5) * 2 * ocrJitterPx),
      top: Math.round(y - 10 + (random() - 0.5) * 2 * ocrJitterPx), width: textWidth, height: 20,
    });
  }
  for (let y = plot.top; y <= plot.bottom; y += 1) blend(plot.left, y, [60, 60, 60]);
  const groupCount = Math.ceil(valueList.length / groupSize);
  const slot = (plot.right - plot.left) / groupCount;
  const barWidth = groupSize > 1 ? slot * 0.3 : slot * barRatio;
  const barList = [];
  // 막대는 baseValue(기본: 축 맨 아래 값)에서 값까지 그린다. 음수 막대는 바닥선 아래로 내려간다.
  const baseY = yOf(baseValue ?? axis.min);
  valueList.forEach((value, index) => {
    const group = Math.floor(index / groupSize);
    const member = index % groupSize;
    const cx = plot.left + slot * (group + 0.5) + (groupSize > 1 ? (member - (groupSize - 1) / 2) * barWidth * 1.05 : 0);
    const base = colorList[index % colorList.length];
    const color = pale ? base.map((c) => Math.round(c + (255 - c) * 0.6)) : base;
    const top = Math.min(yOf(value), baseY);
    const bottom = Math.max(yOf(value), baseY);
    if (gradient) {
      for (let y = Math.floor(top); y < bottom; y += 1) {
        const t = (y - plot.top) / (plot.bottom - plot.top);
        fillRect(cx - barWidth / 2, Math.max(y, top), cx + barWidth / 2, y + 1, [Math.round(30 + 200 * t), Math.round(80 + 150 * t), 200]);
      }
    } else if (stacked) {
      const split = top + (bottom - top) * 0.4;
      fillRect(cx - barWidth / 2, top, cx + barWidth / 2, split, PALETTE.orange);
      fillRect(cx - barWidth / 2, split, cx + barWidth / 2, bottom, color);
    } else {
      fillRect(cx - barWidth / 2, top, cx + barWidth / 2, bottom, color);
    }
    if (insideText) fillRect(cx - 20, top + 20, cx + 20, top + 34, [255, 255, 255]);
    barList.push({ cx, top, value });
  });
  for (let x = plot.left; x < plot.right; x += 1) blend(x, plot.bottom, [60, 60, 60]);
  const labelIndexList = valueLabels === 'partial' ? [1, 3] : valueList.map((_, index) => index);
  if (valueLabels) {
    for (const index of labelIndexList) {
      const { cx, top, value } = barList[index];
      const text = String(value);
      const labelTop = valueLabels === 'inside' ? top + 8 : top - 28;
      fillRect(cx - text.length * 5.5, labelTop + 4, cx + text.length * 5.5, labelTop + 16, valueLabels === 'inside' ? [255, 255, 255] : [40, 40, 40]);
      lineList.push({ text, score: 0.95, left: Math.round(cx - text.length * 5.5), top: Math.round(labelTop), width: Math.round(text.length * 11), height: 20 });
    }
  }
  if (legend) {
    fillRect(1040, 300, 1060, 320, colorList[0]);
    lineList.push({ text: '1인당 소비량', score: 0.95, left: 1070, top: 300, width: 120, height: 20 });
  }
  const tokenList = categoryList || Array.from({ length: groupCount }, (_, index) => String(2015 + index));
  if (categoryLine) {
    const firstCx = plot.left + slot * 0.5;
    tokenList.forEach((_, index) => fillRect(firstCx + slot * index - 20, plot.bottom + 16, firstCx + slot * index + 20, plot.bottom + 28, [60, 60, 60]));
    lineList.push({
      text: tokenList.join(' '), score: 0.95, left: Math.round(firstCx - 22), top: plot.bottom + 12,
      width: Math.round(slot * (groupCount - 1) + 44), height: 20,
    });
  }
  lineList.push(...extraLineList);
  if (noise) degrade(canvas.bitmap, { seed });
  return { bitmap: canvas.bitmap, lineList, truthList: valueList, canvas };
}
