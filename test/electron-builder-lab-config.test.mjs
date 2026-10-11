import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBuilderConfig } = require('../electron-builder.config.js');
const loadLabBuilderConfig = require('../electron-builder.lab.config.js');
const { createLabBuilderConfig } = loadLabBuilderConfig;

const option = { env: {}, fileExists: () => true, warn: () => {}, kiwiModelDir: '/build/vendor/kiwi-model' };

test('실험 창 설치본은 시작 파일을 실험 창으로 두고 앱 이름·appId·설치 이름을 제품과 나눈다', () => {
  const config = createLabBuilderConfig(option);
  assert.equal(config.appId, 'kr.seeon.lab');
  assert.equal(config.productName, 'SEEON Lab');
  assert.deepEqual(config.extraMetadata, { main: 'src/main/lab/index.js', productName: 'SEEON Lab', author: { name: 'SEEON' } });
  assert.equal(config.nsis.shortcutName, 'SEEON Lab');
  assert.equal(config.nsis.artifactName, 'SEEON-Lab-Setup-${version}.${ext}');
});

test('실험 창 설치본도 제품과 같은 코드·비밀·Kiwi 모델·설치 방식으로 묶는다', () => {
  const lab = createLabBuilderConfig(option);
  const meet = createBuilderConfig(option);
  assert.deepEqual(lab.files, meet.files);
  assert.deepEqual(lab.extraResources, meet.extraResources);
  assert.deepEqual(lab.asarUnpack, meet.asarUnpack);
  assert.deepEqual(lab.win, meet.win);
  assert.deepEqual({ ...lab.nsis, shortcutName: null, artifactName: null }, { ...meet.nsis, shortcutName: null, artifactName: null });
});

test('electron-builder 가 부르는 기본 내보내기는 실험 창 설정을 만든다', () => {
  assert.equal(typeof loadLabBuilderConfig, 'function');
});
