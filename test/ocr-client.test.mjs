import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOcrClient, OcrRequestError, OCR_REQUEST_TIMEOUT_MS } = require('../src/main/caption-pipeline/agents/shared/ocr-client.js');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const jpegBuffer = Buffer.from('jpeg');
const config = { ocrUrl: 'http://127.0.0.1:8804/ocr' };
const okBody = {
  text: '제목', lineList: [{ text: '제목', score: 0.95, left: 1, top: 2, width: 3, height: 4 }],
  imageWidth: 1920, imageHeight: 1080, meanScore: 0.95, verticalBoxRatio: 0, elapsedMs: 300, engine: { name: 'rapidocr' },
};

function respond({ status = 200, body = okBody, isJson = true } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300, status,
    json: async () => { if (!isJson) throw new SyntaxError('bad json'); return body; },
  });
}

async function catchError(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail('예외가 나야 한다');
}

test('상한은 5초', () => {
  assert.equal(OCR_REQUEST_TIMEOUT_MS, 5000);
});

test('JPEG 를 image/jpeg 로 보내고 서버 JSON 을 그대로 돌려준다', async () => {
  let request = null;
  globalThis.fetch = async (url, init) => { request = { url, init }; return respond()(); };
  const result = await createOcrClient({ config }).recognize({ jpegBuffer });
  assert.deepEqual(result, okBody);
  assert.equal(request.url, config.ocrUrl);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers['content-type'], 'image/jpeg');
  assert.equal(request.init.body, jpegBuffer);
});

test('연결 실패·시간 초과는 서비스 다운', async () => {
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  const error = await catchError(createOcrClient({ config }).recognize({ jpegBuffer }));
  assert.ok(error instanceof OcrRequestError);
  assert.equal(error.isServiceDown, true);
});

test('5xx 는 서비스 다운, 4xx 는 아니다', async () => {
  globalThis.fetch = respond({ status: 503 });
  assert.equal((await catchError(createOcrClient({ config }).recognize({ jpegBuffer }))).isServiceDown, true);
  globalThis.fetch = respond({ status: 400 });
  const error = await catchError(createOcrClient({ config }).recognize({ jpegBuffer }));
  assert.equal(error.isServiceDown, false);
  assert.match(error.message, /400/);
});

test('JSON 이 아니거나 형식이 다르면 서비스 다운이 아닌 오류', async () => {
  globalThis.fetch = respond({ isJson: false });
  assert.equal((await catchError(createOcrClient({ config }).recognize({ jpegBuffer }))).isServiceDown, false);
  for (const body of [{ ...okBody, lineList: 'x' }, { ...okBody, meanScore: 'high' }, { ...okBody, text: null }, { ...okBody, lineList: [{ score: 1 }] }]) {
    globalThis.fetch = respond({ body });
    const error = await catchError(createOcrClient({ config }).recognize({ jpegBuffer }));
    assert.equal(error.isServiceDown, false, JSON.stringify(body));
  }
});

test('주소가 없으면 요청하지 않고 서비스 다운이 아닌 오류', async () => {
  let isCalled = false;
  globalThis.fetch = async () => { isCalled = true; return respond()(); };
  const error = await catchError(createOcrClient({ config: { ocrUrl: '' } }).recognize({ jpegBuffer }));
  assert.equal(error.isServiceDown, false);
  assert.equal(isCalled, false);
});
