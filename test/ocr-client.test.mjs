import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createOcrClient, OcrRequestError, OCR_REQUEST_TIMEOUT_MS, OCR_BYPASS_MS,
} = require('../src/main/caption-pipeline/agents/shared/ocr-client.js');
const { createSlideTextAgent } = require('../src/main/caption-pipeline/agents/slide-text-agent.js');
const { createScreenTextGrounding } = require('../src/main/caption-pipeline/orchestrator/screen-text-grounding.js');

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

// 서비스 다운 뒤 우회 창은 클라이언트가 들고 있어, 슬라이드 전사와 수치 해설 근거가 같은 상태를 쓴다.
test('우회 창은 60초', () => {
  assert.equal(OCR_BYPASS_MS, 60000);
});

test('서비스 다운(연결 실패·5xx)이면 60초 동안 요청하지 않고 우회 오류를 낸다', async () => {
  for (const failure of [async () => { throw new Error('fetch failed'); }, respond({ status: 502 })]) {
    let nowMs = 1000;
    let fetchCount = 0;
    globalThis.fetch = async (...argList) => { fetchCount += 1; return failure(...argList); };
    const client = createOcrClient({ config, now: () => nowMs });
    await catchError(client.recognize({ jpegBuffer }));
    assert.equal(fetchCount, 1);
    assert.equal(client.isBypassed(), true);
    nowMs += OCR_BYPASS_MS - 1;
    const bypassError = await catchError(client.recognize({ jpegBuffer }));
    assert.ok(bypassError instanceof OcrRequestError);
    assert.equal(bypassError.isBypassed, true);
    assert.equal(bypassError.isServiceDown, true);
    assert.equal(fetchCount, 1, '우회 중에는 요청하지 않는다');
    nowMs += 1;
    assert.equal(client.isBypassed(), false);
    globalThis.fetch = async () => { fetchCount += 1; return respond()(); };
    assert.deepEqual(await client.recognize({ jpegBuffer }), okBody);
    assert.equal(fetchCount, 2);
  }
});

test('4xx·형식 오류는 그 장만의 오류라 우회 창을 열지 않는다', async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount += 1; return respond({ status: 400 })(); };
  const client = createOcrClient({ config });
  const error = await catchError(client.recognize({ jpegBuffer }));
  assert.equal(error.isBypassed, false);
  assert.equal(client.isBypassed(), false);
  await catchError(client.recognize({ jpegBuffer }));
  assert.equal(fetchCount, 2);
});

test('근거 OCR 이 연 우회 창을 슬라이드 전사도 쓴다(같은 클라이언트)', async () => {
  const vlmConfig = { ...config, vlmUrl: 'http://vlm', vlmModel: 'm', slideTextBackend: 'ocr' };
  let ocrFetchCount = 0;
  globalThis.fetch = async (url) => {
    if (url === config.ocrUrl) { ocrFetchCount += 1; throw new Error('fetch failed'); }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'VLM 글' } }] }) };
  };
  const client = createOcrClient({ config: vlmConfig });
  const grounding = createScreenTextGrounding({ ocrClient: client });
  const { record } = await grounding.start({ jpegBuffer }).waitForPrompt();
  assert.match(record.skipReason, /^ocr_error:OCR 연결 실패/);
  const transcribed = await createSlideTextAgent({ config: vlmConfig, ocrClient: client }).transcribe({ jpegBuffer });
  assert.equal(transcribed.source, 'vlm');
  assert.equal(transcribed.fallbackReason, 'ocr_bypass');
  const { record: secondRecord } = await grounding.start({ jpegBuffer }).waitForPrompt();
  assert.equal(secondRecord.skipReason, 'ocr_bypass');
  assert.equal(ocrFetchCount, 1);
});
