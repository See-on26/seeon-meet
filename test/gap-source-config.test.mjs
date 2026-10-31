import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readPipelineConfig, GAP_SOURCE_LIST, DEFAULT_GAP_SOURCE } = require('../src/main/caption-pipeline/config.js');

afterEach(() => { mock.restoreAll(); });

test('틈 후보 출처: 기본은 asr(지금 동작), asr·audio 는 경고 없이 받는다', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.deepEqual(GAP_SOURCE_LIST, ['asr', 'audio']);
  assert.equal(DEFAULT_GAP_SOURCE, 'asr');
  assert.equal(readPipelineConfig({}).gapSource, 'asr');
  assert.equal(readPipelineConfig({ SEEON_GAP_SOURCE: '' }).gapSource, 'asr');
  assert.equal(readPipelineConfig({ SEEON_GAP_SOURCE: 'audio' }).gapSource, 'audio');
  assert.equal(warn.mock.callCount(), 0);
});

test('틈 후보 출처: 허용하지 않는 값은 한 번 경고하고 asr 로 둔다', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(readPipelineConfig({ SEEON_GAP_SOURCE: 'AUDIO' }).gapSource, 'asr');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /SEEON_GAP_SOURCE/);
});
