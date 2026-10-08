import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  readPipelineConfig, SLIDE_TEXT_BACKEND_LIST, DEFAULT_SLIDE_TEXT_BACKEND,
} = require('../src/main/caption-pipeline/config.js');

afterEach(() => { mock.restoreAll(); });

test('전사 백엔드: 기본은 vlm, vlm·ocr 은 경고 없이 받는다', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.deepEqual(SLIDE_TEXT_BACKEND_LIST, ['vlm', 'ocr']);
  assert.equal(DEFAULT_SLIDE_TEXT_BACKEND, 'vlm');
  assert.equal(readPipelineConfig({}).slideTextBackend, 'vlm');
  assert.equal(readPipelineConfig({ SEEON_SLIDE_TEXT_BACKEND: '' }).slideTextBackend, 'vlm');
  assert.equal(readPipelineConfig({ SEEON_SLIDE_TEXT_BACKEND: 'vlm' }).slideTextBackend, 'vlm');
  assert.equal(readPipelineConfig({ SEEON_SLIDE_TEXT_BACKEND: 'ocr' }).slideTextBackend, 'ocr');
  assert.equal(warn.mock.callCount(), 0);
});

test('전사 백엔드: 허용하지 않는 값(대문자·뒤 공백 포함)은 한 번 경고하고 vlm 으로 둔다', () => {
  const warn = mock.method(console, 'warn', () => {});
  for (const backend of ['OCR', 'ocr ']) {
    warn.mock.resetCalls();
    assert.equal(readPipelineConfig({ SEEON_SLIDE_TEXT_BACKEND: backend }).slideTextBackend, 'vlm', JSON.stringify(backend));
    assert.equal(warn.mock.callCount(), 1, JSON.stringify(backend));
    assert.match(warn.mock.calls[0].arguments[0], /SEEON_SLIDE_TEXT_BACKEND/);
    assert.ok(warn.mock.calls[0].arguments[0].includes(`"${backend}"`));
  }
});

test('OCR 주소: 없으면 임베딩 주소의 origin + /ocr, SEEON_OCR_URL 이 있으면 그 값', () => {
  assert.equal(readPipelineConfig({}).ocrUrl, 'http://127.0.0.1:8804/ocr');
  assert.equal(readPipelineConfig({ SEEON_EMBED_URL: 'http://localhost:9904/embed' }).ocrUrl, 'http://localhost:9904/ocr');
  assert.equal(readPipelineConfig({ SEEON_OCR_URL: 'http://127.0.0.1:8806/ocr' }).ocrUrl, 'http://127.0.0.1:8806/ocr');
});

test('OCR 주소: 임베딩 주소가 주소 형식이 아니면 설정은 죽지 않고 빈 문자열', () => {
  assert.equal(readPipelineConfig({ SEEON_EMBED_URL: 'not a url' }).ocrUrl, '');
});
