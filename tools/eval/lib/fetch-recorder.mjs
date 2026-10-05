import { AsyncLocalStorage } from 'node:async_hooks';

// production 라우터는 HTTP 오류·파싱 실패를 통과로 처리하고 원문을 남기지 않는다.
// 전역 fetch 를 감싸 호출마다 원문 응답을 모은다. 요청 헤더(토큰)는 남기지 않는다.
export function createFetchRecorder({ baseFetch = globalThis.fetch.bind(globalThis) } = {}) {
  const storage = new AsyncLocalStorage();

  async function recordingFetch(input, init) {
    const captureList = storage.getStore();
    const startedAt = Date.now();
    try {
      const response = await baseFetch(input, init);
      if (captureList) {
        captureList.push({
          url: String(input), status: response.status, bodyText: await response.clone().text(),
          elapsedMs: Date.now() - startedAt, errorMessage: null,
        });
      }
      return response;
    } catch (error) {
      captureList?.push({
        url: String(input), status: null, bodyText: '', elapsedMs: Date.now() - startedAt, errorMessage: error.message,
      });
      throw error;
    }
  }

  async function capture(run) {
    const captureList = [];
    const result = await storage.run(captureList, run);
    return { result, captureList };
  }

  return { fetch: recordingFetch, capture };
}

// 기록된 요청이 하나도 없을 때의 errorMessage. production 이 토큰이 없어 요청 전에 멈춘 경우다.
export const NO_REQUEST_ERROR = 'no_request';

// Bedrock Converse 응답 원문에서 글·종료 사유·사용량을 꺼낸다.
export function summarizeConverseCapture(captureList) {
  const last = captureList.at(-1);
  if (!last) return { status: null, stopReason: null, usage: null, rawText: null, errorMessage: NO_REQUEST_ERROR, elapsedMs: null };
  let json = null;
  try {
    json = JSON.parse(last.bodyText);
  } catch {
    json = null;
  }
  const partList = json?.output?.message?.content;
  const textPart = Array.isArray(partList)
    ? partList.find((part) => typeof part?.text === 'string' && part.text.trim()) : null;
  return {
    status: last.status,
    stopReason: json?.stopReason ?? null,
    usage: json?.usage ?? null,
    rawText: textPart ? textPart.text : (last.status === 200 ? '' : last.bodyText.slice(0, 300)),
    errorMessage: last.errorMessage,
    elapsedMs: last.elapsedMs,
  };
}
