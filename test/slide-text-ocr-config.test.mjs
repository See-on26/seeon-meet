import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  readPipelineConfig, SLIDE_TEXT_BACKEND_LIST, DEFAULT_SLIDE_TEXT_BACKEND,
} = require('../src/main/caption-pipeline/config.js');

test('전사 백엔드: 기본은 vlm, vlm·ocr 만 받고 그 밖의 값은 기본값', () => {
  assert.deepEqual(SLIDE_TEXT_BACKEND_LIST, ['vlm', 'ocr']);
  assert.equal(DEFAULT_SLIDE_TEXT_BACKEND, 'vlm');
  assert.equal(readPipelineConfig({}).slideTextBackend, 'vlm');
  assert.equal(readPipelineConfig({ SEEON_SLIDE_TEXT_BACKEND: 'ocr' }).slideTextBackend, 'ocr');
  assert.equal(readPipelineConfig({ SEEON_SLIDE_TEXT_BACKEND: 'OCR' }).slideTextBackend, 'vlm');
});

test('OCR 주소: 없으면 임베딩 주소의 origin + /ocr, SEEON_OCR_URL 이 있으면 그 값', () => {
  assert.equal(readPipelineConfig({}).ocrUrl, 'http://127.0.0.1:8804/ocr');
  assert.equal(readPipelineConfig({ SEEON_EMBED_URL: 'http://localhost:9904/embed' }).ocrUrl, 'http://localhost:9904/ocr');
  assert.equal(readPipelineConfig({ SEEON_OCR_URL: 'http://127.0.0.1:8806/ocr' }).ocrUrl, 'http://127.0.0.1:8806/ocr');
});

test('OCR 주소: 임베딩 주소가 주소 형식이 아니면 설정은 죽지 않고 빈 문자열', () => {
  assert.equal(readPipelineConfig({ SEEON_EMBED_URL: 'not a url' }).ocrUrl, '');
});
