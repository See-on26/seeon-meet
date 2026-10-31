// 화면 글자 OCR(GPU 서버 임베딩 서비스의 /ocr) 클라이언트. 슬라이드 전사와 수치 해설 근거가 함께 쓴다.
// 서비스가 응답하지 않는 오류(연결 실패·시간 초과·5xx)와 그 장만의 오류(4xx·형식)를 isServiceDown 으로 가른다.
const REQUEST_TIMEOUT_MS = 5000;
// 서비스가 응답하지 않으면 이 시간 동안 요청하지 않고 바로 우회 오류를 낸다. 장마다 상한까지 기다리지 않기 위해서다.
// 상태를 클라이언트가 들고 있어 전사와 근거가 같은 창을 쓴다.
const OCR_BYPASS_MS = 60000;

class OcrRequestError extends Error {
  constructor(message, { isServiceDown, isBypassed = false }) {
    super(message);
    this.name = 'OcrRequestError';
    this.isServiceDown = isServiceDown;
    this.isBypassed = isBypassed;
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

function createOcrClient({ config, timeoutMs = REQUEST_TIMEOUT_MS, bypassMs = OCR_BYPASS_MS, now = Date.now }) {
  let bypassUntil = 0;

  function isBypassed() {
    return now() < bypassUntil;
  }

  function failServiceDown(message) {
    bypassUntil = now() + bypassMs;
    return new OcrRequestError(message, { isServiceDown: true });
  }

  async function recognize({ jpegBuffer }) {
    if (!config.ocrUrl) throw new OcrRequestError('OCR 주소 없음', { isServiceDown: false });
    if (isBypassed()) throw new OcrRequestError('OCR 서비스 응답 없음 — 잠시 건너뜀', { isServiceDown: true, isBypassed: true });
    let response;
    try {
      response = await fetch(config.ocrUrl, {
        method: 'POST',
        headers: { 'content-type': 'image/jpeg' },
        body: jpegBuffer,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw failServiceDown(`OCR 연결 실패: ${error.message}`);
    }
    if (response.status >= 500) throw failServiceDown(`OCR HTTP ${response.status}`);
    if (!response.ok) throw new OcrRequestError(`OCR HTTP ${response.status}`, { isServiceDown: false });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new OcrRequestError('OCR 응답이 JSON 이 아님', { isServiceDown: false });
    }
    if (!isOcrResponse(body)) throw new OcrRequestError('OCR 응답 형식이 다름', { isServiceDown: false });
    return body;
  }

  return { recognize, isBypassed };
}

module.exports = { createOcrClient, OcrRequestError, OCR_REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS, OCR_BYPASS_MS };
