const SSIM_C1 = (0.01 * 255) ** 2;
const SSIM_C2 = (0.03 * 255) ** 2;

export function convertToGrayscale({ data, width, height }) {
  const pixelCount = width * height;
  const gray = new Float64Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4;
    gray[i] = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
  }
  return gray;
}

function computeCellSsim({ grayA, grayB, width, cellX, cellY, cellWidth, cellHeight }) {
  let sumA = 0; let sumB = 0;
  const count = cellWidth * cellHeight;
  for (let y = cellY; y < cellY + cellHeight; y += 1) {
    for (let x = cellX; x < cellX + cellWidth; x += 1) {
      const i = y * width + x;
      sumA += grayA[i]; sumB += grayB[i];
    }
  }
  const meanA = sumA / count;
  const meanB = sumB / count;
  let varA = 0; let varB = 0; let covariance = 0;
  for (let y = cellY; y < cellY + cellHeight; y += 1) {
    for (let x = cellX; x < cellX + cellWidth; x += 1) {
      const i = y * width + x;
      const deltaA = grayA[i] - meanA;
      const deltaB = grayB[i] - meanB;
      varA += deltaA * deltaA; varB += deltaB * deltaB; covariance += deltaA * deltaB;
    }
  }
  varA /= count; varB /= count; covariance /= count;
  return ((2 * meanA * meanB + SSIM_C1) * (2 * covariance + SSIM_C2))
    / ((meanA * meanA + meanB * meanB + SSIM_C1) * (varA + varB + SSIM_C2));
}

export function computeGridSsimList({ grayA, grayB, width, height, rowCount, colCount }) {
  const ssimList = new Float64Array(rowCount * colCount);
  for (let row = 0; row < rowCount; row += 1) {
    const cellY = Math.floor((row * height) / rowCount);
    const cellHeight = Math.floor(((row + 1) * height) / rowCount) - cellY;
    for (let col = 0; col < colCount; col += 1) {
      const cellX = Math.floor((col * width) / colCount);
      const cellWidth = Math.floor(((col + 1) * width) / colCount) - cellX;
      ssimList[row * colCount + col] = computeCellSsim({
        grayA, grayB, width, cellX, cellY, cellWidth, cellHeight,
      });
    }
  }
  return ssimList;
}
