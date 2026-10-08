// 슬라이드 전사용 OCR(GPU 서버 임베딩 서비스의 /ocr) 클라이언트.
// 서비스가 응답하지 않는 오류(연결 실패·시간 초과·5xx)와 그 장만의 오류(4xx·형식)를 isServiceDown 으로 가른다.
const REQUEST_TIMEOUT_MS = 5000;

class OcrRequestError extends Error {
  constructor(message, { isServiceDown }) {
    super(message);
    this.name = 'OcrRequestError';
    this.isServiceDown = isServiceDown;
  }
}

function isOcrLine(line) {
  return Boolean(line) && typeof line.text === 'string';
}

function isOcrResponse(body) {
  return Boolean(body)
    && typeof body.text === 'string'
    && Array.isArray(body.lineList) && body.lineList.every(isOcrLine)
    && Number.isFinite(body.meanScore)
    && Number.isFinite(body.verticalBoxRatio);
}

function createOcrClient({ config, timeoutMs = REQUEST_TIMEOUT_MS }) {
  async function recognize({ jpegBuffer }) {
    if (!config.ocrUrl) throw new OcrRequestError('OCR 주소 없음', { isServiceDown: false });
    let response;
    try {
      response = await fetch(config.ocrUrl, {
        method: 'POST',
        headers: { 'content-type': 'image/jpeg' },
        body: jpegBuffer,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new OcrRequestError(`OCR 연결 실패: ${error.message}`, { isServiceDown: true });
    }
    if (!response.ok) {
      throw new OcrRequestError(`OCR HTTP ${response.status}`, { isServiceDown: response.status >= 500 });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new OcrRequestError('OCR 응답이 JSON 이 아님', { isServiceDown: false });
    }
    if (!isOcrResponse(body)) throw new OcrRequestError('OCR 응답 형식이 다름', { isServiceDown: false });
    return body;
  }

  return { recognize };
}

module.exports = { createOcrClient, OcrRequestError, OCR_REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS };
