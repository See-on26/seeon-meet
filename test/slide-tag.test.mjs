import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatHeardSlideTag } = require('../src/main/caption-pipeline/context/slide-tag.js');

test('들은 번호가 있으면 "슬라이드 N", 없으면 "번호 없는 화면" 이다', () => {
  assert.equal(formatHeardSlideTag({ displayNumber: 2 }), '슬라이드 2');
  assert.equal(formatHeardSlideTag({ displayNumber: null }), '번호 없는 화면');
  assert.equal(formatHeardSlideTag({ displayNumber: undefined }), '번호 없는 화면');
  assert.equal(formatHeardSlideTag({ displayNumber: 0 }), '번호 없는 화면');
});
