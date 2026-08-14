import { convertToGrayscale } from './ssim.js';

const DEFAULT_BIN_COUNT = 32;

export function computeBlockHistogramList({ imageData, rowCount, colCount, binCount = DEFAULT_BIN_COUNT }) {
  const { width, height } = imageData;
  const gray = convertToGrayscale(imageData);
  const histogramList = [];
  for (let row = 0; row < rowCount; row += 1) {
    const blockY = Math.floor((row * height) / rowCount);
    const blockEndY = Math.floor(((row + 1) * height) / rowCount);
    for (let col = 0; col < colCount; col += 1) {
      const blockX = Math.floor((col * width) / colCount);
      const blockEndX = Math.floor(((col + 1) * width) / colCount);
      const histogram = new Float64Array(binCount);
      let pixelCount = 0;
      for (let y = blockY; y < blockEndY; y += 1) {
        for (let x = blockX; x < blockEndX; x += 1) {
          const bin = Math.min(binCount - 1, Math.floor((gray[y * width + x] * binCount) / 256));
          histogram[bin] += 1;
          pixelCount += 1;
        }
      }
      if (pixelCount) for (let bin = 0; bin < binCount; bin += 1) histogram[bin] /= pixelCount;
      histogramList.push(histogram);
    }
  }
  return histogramList;
}

export function computeBhattacharyyaDistance({ histogramA, histogramB }) {
  let coefficient = 0;
  for (let bin = 0; bin < histogramA.length; bin += 1) {
    coefficient += Math.sqrt(histogramA[bin] * histogramB[bin]);
  }
  return Math.sqrt(Math.max(0, 1 - coefficient));
}

export function computeMeanBhattacharyyaDistance({ histogramListA, histogramListB }) {
  if (!histogramListA.length) return 0;
  let sum = 0;
  for (let i = 0; i < histogramListA.length; i += 1) {
    sum += computeBhattacharyyaDistance({ histogramA: histogramListA[i], histogramB: histogramListB[i] });
  }
  return sum / histogramListA.length;
}
