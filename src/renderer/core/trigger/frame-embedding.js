import { convertToGrayscale } from './ssim.js';

const DEFAULT_ROW_COUNT = 9;
const DEFAULT_COL_COUNT = 16;

export function computeGridEmbedding(imageData, { rowCount = DEFAULT_ROW_COUNT, colCount = DEFAULT_COL_COUNT } = {}) {
  const gray = convertToGrayscale(imageData);
  const { width, height } = imageData;
  const vector = new Array(rowCount * colCount).fill(0);
  for (let row = 0; row < rowCount; row += 1) {
    const cellY = Math.floor((row * height) / rowCount);
    const cellHeight = Math.floor(((row + 1) * height) / rowCount) - cellY;
    for (let col = 0; col < colCount; col += 1) {
      const cellX = Math.floor((col * width) / colCount);
      const cellWidth = Math.floor(((col + 1) * width) / colCount) - cellX;
      let sum = 0;
      for (let y = cellY; y < cellY + cellHeight; y += 1) {
        for (let x = cellX; x < cellX + cellWidth; x += 1) sum += gray[y * width + x];
      }
      const count = cellWidth * cellHeight;
      vector[row * colCount + col] = count ? sum / count : 0;
    }
  }

  let mean = 0;
  for (const value of vector) mean += value;
  mean /= vector.length;
  let normSquared = 0;
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] -= mean;
    normSquared += vector[i] * vector[i];
  }
  const norm = Math.sqrt(normSquared) || 1;
  return vector.map((value) => value / norm);
}
