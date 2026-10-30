import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBuilderConfig } = require('../electron-builder.config.js');

// ICO 머리(6바이트) 뒤의 항목(16바이트씩)에서 가로 크기를 읽는다. 0 은 256 이다.
function readIcoSizeList(filePath) {
  const buffer = fs.readFileSync(filePath);
  const count = buffer.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => buffer[6 + index * 16] || 256);
}

const KIWI_MODEL_DIR = '/kiwi-model';
const config = createBuilderConfig({
  env: {}, fileExists: (filePath) => filePath.startsWith(KIWI_MODEL_DIR), warn: () => {}, kiwiModelDir: KIWI_MODEL_DIR,
});

test('Windows 설치본·바로가기·창 아이콘은 크기별로 다듬은 ICO 를 쓴다(작은 크기에서도 둥근 모서리가 깔끔하게)', () => {
  assert.equal(config.win.icon, 'build/icon.ico');
  const sizeList = readIcoSizeList(new URL('../build/icon.ico', import.meta.url));
  for (const size of [16, 24, 32, 48, 256]) assert.ok(sizeList.includes(size), `${size}px 가 있어야 한다 (지금 ${sizeList})`);
});

test('맥 아이콘은 1024px PNG 를 쓴다', () => {
  assert.equal(config.mac.icon, 'build/icon.png');
  const buffer = fs.readFileSync(new URL('../build/icon.png', import.meta.url));
  assert.equal(buffer.readUInt32BE(16), 1024);
  assert.equal(buffer.readUInt32BE(20), 1024);
});
