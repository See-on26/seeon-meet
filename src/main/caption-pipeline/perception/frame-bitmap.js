// 그래프 어림에 쓰는 프레임 처리: 해설 요청 프레임(JPEG)을 화소로 풀고, 어림에 쓴 그림을 나중에 사람이 볼 수 있게 남긴다.
// 푸는 일은 Electron main 의 nativeImage 가 한다. Electron 밖(공장 shim·node 시험)에는 nativeImage 가 없어
// 디코더가 없고, 그래프 어림은 no_decoder 로 건너뛴다.
const fs = require('fs');
const path = require('path');

function resolveNativeImage() {
  try {
    const nativeImage = require('electron')?.nativeImage;
    return typeof nativeImage?.createFromBuffer === 'function' ? nativeImage : null;
  } catch {
    return null;
  }
}

// toBitmap() 은 플랫폼 순서(대개 BGRA)로 낸다. 어림기는 색 거리와 사영만 써서 채널 순서와 상관없다.
function createFrameDecoder({ nativeImage }) {
  if (!nativeImage) return null;
  function decode(jpegBuffer) {
    const image = nativeImage.createFromBuffer(Buffer.from(jpegBuffer));
    if (!image || image.isEmpty()) return null;
    const { width, height } = image.getSize();
    const data = image.toBitmap();
    if (!width || !height || data?.length !== width * height * 4) return null;
    return { width, height, data };
  }
  return { decode };
}

// 파일 이름은 해설 요청 시각(ts)과 영상 시각이다. ts 로 기록(pipeline-*.jsonl)의 같은 요청을 찾는다.
function buildChartFrameTag({ ts, videoTimeMs = null }) {
  const videoTag = Number.isFinite(videoTimeMs) ? `-${(videoTimeMs / 1000).toFixed(2)}s` : '';
  return `${ts}${videoTag}`;
}

// 쓰기는 기다리지 않는다(해설을 늦추지 않는다). 실패하면 경고만 남긴다.
function createChartFrameSaver({ dir, fsPromises = fs.promises }) {
  let writeChain = Promise.resolve();
  function save({ jpegBuffer, frameTag }) {
    const filePath = path.join(dir, `${path.basename(String(frameTag))}.jpg`);
    writeChain = writeChain
      .then(() => fsPromises.mkdir(dir, { recursive: true }))
      .then(() => fsPromises.writeFile(filePath, Buffer.from(jpegBuffer)))
      .catch((error) => console.warn(`[pipeline] 그래프 어림 프레임 저장 실패(무시) ${filePath}: ${error.message}`));
    return filePath;
  }
  return { save, flush: () => writeChain };
}

module.exports = { resolveNativeImage, createFrameDecoder, buildChartFrameTag, createChartFrameSaver };
