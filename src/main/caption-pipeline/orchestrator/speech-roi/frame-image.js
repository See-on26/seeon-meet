// 발화 ROI 가 쓰는 그림 다루기(Electron nativeImage): 크기 읽기, 신선도 확인용 회색 축소판, 확대 그림 자르기.
// 같은 JPEG 를 해설 한 번에 여러 번 쓰므로(축소판·크기·자르기) 디코드한 그림을 Buffer 마다 한 번만 만든다.

const THUMB_WIDTH = 128;
const THUMB_HEIGHT = 72;
// 확대 그림도 긴 변 1280 으로 키운다. 서버가 작은 그림을 예산까지 키우는지에 기대지 않고 두 장이 같은 토큰 예산을 갖게 한다.
const ZOOM_LONG_EDGE = 1280;
const ZOOM_JPEG_QUALITY = 92;

function loadNativeImage() {
  return require('electron').nativeImage;
}

function createFrameImageOps({ nativeImage = null } = {}) {
  const imageByBufferMap = new WeakMap();

  function decode(jpeg) {
    if (!jpeg || typeof jpeg !== 'object') return null;
    if (imageByBufferMap.has(jpeg)) return imageByBufferMap.get(jpeg);
    let image = null;
    try {
      image = (nativeImage || loadNativeImage()).createFromBuffer(jpeg);
      if (!image || image.isEmpty()) image = null;
    } catch {
      image = null;
    }
    imageByBufferMap.set(jpeg, image);
    return image;
  }

  function readSize(jpeg) {
    const image = decode(jpeg);
    return image ? image.getSize() : null;
  }

  // BGRA 비트맵을 밝기(0~255) 한 채널로 줄인다.
  function toGrayThumbnail(jpeg) {
    const image = decode(jpeg);
    if (!image) return null;
    const bitmap = image.resize({ width: THUMB_WIDTH, height: THUMB_HEIGHT, quality: 'good' }).toBitmap();
    const data = new Uint8Array(THUMB_WIDTH * THUMB_HEIGHT);
    for (let index = 0; index < data.length; index += 1) {
      const offset = index * 4;
      data[index] = Math.round(0.114 * bitmap[offset] + 0.587 * bitmap[offset + 1] + 0.299 * bitmap[offset + 2]);
    }
    return { width: THUMB_WIDTH, height: THUMB_HEIGHT, data };
  }

  // 비율 상자(0~1)를 화소로 바꿔 자르고 긴 변을 longEdge 로 맞춰 JPEG 로 만든다. 디코드·자르기에 실패하면 null.
  function cropToJpeg({ jpeg, rect, longEdge = ZOOM_LONG_EDGE, quality = ZOOM_JPEG_QUALITY }) {
    const image = decode(jpeg);
    if (!image || !rect) return null;
    try {
      const { width, height } = image.getSize();
      const x = Math.max(0, Math.round(rect.x * width));
      const y = Math.max(0, Math.round(rect.y * height));
      const cropWidth = Math.min(width - x, Math.round(rect.w * width));
      const cropHeight = Math.min(height - y, Math.round(rect.h * height));
      if (cropWidth < 1 || cropHeight < 1) return null;
      const scale = longEdge / Math.max(cropWidth, cropHeight);
      const resized = image.crop({ x, y, width: cropWidth, height: cropHeight }).resize({
        width: Math.round(cropWidth * scale), height: Math.round(cropHeight * scale), quality: 'best',
      });
      const output = resized.toJPEG(quality);
      return output?.length ? Buffer.from(output) : null;
    } catch {
      return null;
    }
  }

  return { readSize, toGrayThumbnail, cropToJpeg };
}

module.exports = { createFrameImageOps, THUMB_WIDTH, THUMB_HEIGHT, ZOOM_LONG_EDGE, ZOOM_JPEG_QUALITY };
