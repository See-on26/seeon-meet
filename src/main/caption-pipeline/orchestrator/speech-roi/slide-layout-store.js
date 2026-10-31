// 새 슬라이드(major)마다 전환 프레임의 OCR 줄 위치를 한 번 뽑아 둔다. 해설 순간 같은 프레임 OCR 이 없을 때
// 발화 ROI 가 꺼내 쓴다(신선도 확인 뒤). 해설 경로 밖(전환 때)에서만 OCR 을 부르고, 해설은 이것을 기다리지 않는다.
const { OCR_MAX_VERTICAL_BOX_RATIO } = require('../../agents/slide-text-agent');

const SLIDE_LAYOUT_STATUS_MAP = { missing: 'missing', pending: 'pending', ready: 'ready', none: 'none', failed: 'failed' };
const SLIDE_LAYOUT_NONE_REASON_MAP = { verticalText: 'vertical_text', noText: 'no_text' };

function toMajorKey(slideLabel) {
  return String(slideLabel ?? '').split('-')[0];
}

// OCR 줄(보낸 JPEG 화소 좌표)을 공유 화면 칸 기준 0~1 비율 상자로 바꾼다. 위치가 없는 줄은 뺀다.
function toLayoutLineList({ lineList = [], imageWidth, imageHeight }) {
  if (!(imageWidth > 0) || !(imageHeight > 0)) return [];
  return (Array.isArray(lineList) ? lineList : [])
    .filter((line) => typeof line?.text === 'string' && line.text.trim()
      && [line.left, line.top, line.width, line.height].every(Number.isFinite) && line.width > 0 && line.height > 0)
    .map((line) => ({
      text: line.text,
      score: Number.isFinite(line.score) ? line.score : null,
      rect: { x: line.left / imageWidth, y: line.top / imageHeight, w: line.width / imageWidth, h: line.height / imageHeight },
    }));
}

// 같은 JPEG(Buffer)로 OCR 을 두 번 보내지 않는다. 전사 백엔드가 ocr 이면 전사와 위치 사전이 /ocr 한 번의 결과를 같이 쓴다.
function createSharedOcrClient({ ocrClient }) {
  const promiseByBufferMap = new WeakMap();
  function recognize({ jpegBuffer }) {
    if (!jpegBuffer || typeof jpegBuffer !== 'object') return ocrClient.recognize({ jpegBuffer });
    if (!promiseByBufferMap.has(jpegBuffer)) {
      let promise;
      try {
        promise = Promise.resolve(ocrClient.recognize({ jpegBuffer }));
      } catch (error) {
        promise = Promise.reject(error);
      }
      promiseByBufferMap.set(jpegBuffer, promise);
    }
    return promiseByBufferMap.get(jpegBuffer);
  }
  return { recognize, isBypassed: () => Boolean(ocrClient.isBypassed?.()) };
}

function createSlideLayoutStore({ recognize, imageOps, now = Date.now, onSettled = () => {} }) {
  let entryByKeyMap = new Map();

  function buildLayout({ result, jpegBuffer }) {
    const size = result?.imageWidth > 0 && result?.imageHeight > 0
      ? { width: result.imageWidth, height: result.imageHeight }
      : imageOps.readSize(jpegBuffer);
    const lineList = toLayoutLineList({ lineList: result?.lineList, imageWidth: size?.width, imageHeight: size?.height });
    const thumb = imageOps.toGrayThumbnail(jpegBuffer);
    return { lineList, aspect: size ? size.width / size.height : null, thumb };
  }

  function settle({ key, entry, status, layout = null, reason = null, errorMessage = '', startedAt }) {
    Object.assign(entry, { status, layout, reason });
    onSettled({ slideLabel: key, status, reason, lineCount: layout?.lineList.length ?? 0, errorMessage, elapsedMs: now() - startedAt });
  }

  // 돌려준 값은 이번에 새로 OCR 을 시작했는지다. 이미 있는 장(다시 온 장 포함)이면 false.
  function ensure({ slideLabel, jpegBuffer }) {
    const key = toMajorKey(slideLabel);
    if (!key || entryByKeyMap.has(key)) return false;
    const entry = { status: SLIDE_LAYOUT_STATUS_MAP.pending, layout: null, reason: null };
    entryByKeyMap.set(key, entry);
    const startedAt = now();
    Promise.resolve()
      .then(() => recognize({ jpegBuffer }))
      .then((result) => {
        if (result?.verticalBoxRatio >= OCR_MAX_VERTICAL_BOX_RATIO) {
          return settle({ key, entry, status: SLIDE_LAYOUT_STATUS_MAP.none, reason: SLIDE_LAYOUT_NONE_REASON_MAP.verticalText, startedAt });
        }
        const layout = buildLayout({ result, jpegBuffer });
        if (!layout.lineList.length || !layout.thumb || !layout.aspect) {
          return settle({ key, entry, status: SLIDE_LAYOUT_STATUS_MAP.none, reason: SLIDE_LAYOUT_NONE_REASON_MAP.noText, startedAt });
        }
        return settle({ key, entry, status: SLIDE_LAYOUT_STATUS_MAP.ready, layout, startedAt });
      })
      .catch((error) => settle({ key, entry, status: SLIDE_LAYOUT_STATUS_MAP.failed, errorMessage: error?.message || String(error), startedAt }));
    return true;
  }

  // 기다리지 않는다. 아직 OCR 중이면 pending 을 돌려주고, 호출부는 확대 없이 간다.
  function get(slideLabel) {
    const entry = entryByKeyMap.get(toMajorKey(slideLabel));
    if (!entry) return { status: SLIDE_LAYOUT_STATUS_MAP.missing, layout: null, reason: null };
    return { status: entry.status, layout: entry.layout, reason: entry.reason };
  }

  // 세션이 바뀌면 비운다. 그 전에 보낸 OCR 이 늦게 끝나도 지난 맵의 항목만 바뀌어 새 세션에 남지 않는다.
  function reset() {
    entryByKeyMap = new Map();
  }

  return { ensure, get, reset };
}

module.exports = {
  createSlideLayoutStore, createSharedOcrClient, toLayoutLineList, SLIDE_LAYOUT_STATUS_MAP, SLIDE_LAYOUT_NONE_REASON_MAP,
};
