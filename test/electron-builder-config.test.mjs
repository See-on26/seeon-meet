import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const loadBuilderConfig = require('../electron-builder.config.js');
const { createBuilderConfig, BUILD_ENV_FILE_KEY, BUILD_TUNNEL_KEY_KEY } = loadBuilderConfig;
const { PACKAGED_ENV_FILE_NAME } = require('../src/main/env.js');
const { PACKAGED_KEY_FILE_NAME } = require('../src/main/gpu-tunnel/tunnel-config.js');
const {
  KIWI_MODEL_FILE_LIST, PACKAGED_KIWI_MODEL_DIR_NAME, DEV_KIWI_MODEL_DIR,
} = require('../src/main/caption-pipeline/trigger/kiwi-model.js');

const ENV_FILE_PATH = '/secure/seeon/.env';
const TUNNEL_KEY_PATH = '/secure/keys/app-tunnel-key';
const KIWI_MODEL_DIR = '/build/vendor/kiwi-model';
const KIWI_MODEL_PATH_LIST = KIWI_MODEL_FILE_LIST.map((name) => path.join(KIWI_MODEL_DIR, name));
const KIWI_RESOURCE = { from: KIWI_MODEL_DIR, to: PACKAGED_KIWI_MODEL_DIR_NAME, filter: KIWI_MODEL_FILE_LIST };

afterEach(() => { mock.restoreAll(); });

function fileExistsAmong(pathList) {
  return (filePath) => pathList.includes(filePath);
}

function makeWarnRecorder() {
  const messageList = [];
  return { messageList, warn: (message) => messageList.push(message) };
}

const PACKAGED_ENV_TEXT = 'SEEON_ASR_LANGUAGE=ko\nSEEON_GPU_SSH_HOST=gpu.example\n';

function buildWith({ env, existingPathList = [ENV_FILE_PATH, TUNNEL_KEY_PATH], envText = PACKAGED_ENV_TEXT }) {
  const recorder = makeWarnRecorder();
  const config = createBuilderConfig({
    env, fileExists: fileExistsAmong([...existingPathList, ...KIWI_MODEL_PATH_LIST]), warn: recorder.warn,
    kiwiModelDir: KIWI_MODEL_DIR, readFile: () => envText,
  });
  return { config, warnMessageList: recorder.messageList };
}

test('빌드 env 이름은 SEEON_BUILD_ENV_FILE·SEEON_BUILD_TUNNEL_KEY 이다', () => {
  assert.equal(BUILD_ENV_FILE_KEY, 'SEEON_BUILD_ENV_FILE');
  assert.equal(BUILD_TUNNEL_KEY_KEY, 'SEEON_BUILD_TUNNEL_KEY');
});

test('두 env 가 있으면 .env 와 터널 키를 앱이 찾는 resources 이름으로 넣고 경고하지 않는다', () => {
  const { config, warnMessageList } = buildWith({
    env: { SEEON_BUILD_ENV_FILE: ENV_FILE_PATH, SEEON_BUILD_TUNNEL_KEY: TUNNEL_KEY_PATH },
  });
  assert.deepEqual(config.extraResources, [
    { from: ENV_FILE_PATH, to: PACKAGED_ENV_FILE_NAME },
    { from: TUNNEL_KEY_PATH, to: PACKAGED_KEY_FILE_NAME },
    KIWI_RESOURCE,
  ]);
  assert.deepEqual(warnMessageList, []);
});

test('env 가 없으면 그 파일을 빼고 만들며, 무엇이 빠지는지 경고한다', () => {
  const { config, warnMessageList } = buildWith({ env: {} });
  assert.deepEqual(config.extraResources, [KIWI_RESOURCE]);
  assert.equal(warnMessageList.length, 2);
  assert.match(warnMessageList[0], /SEEON_BUILD_ENV_FILE/);
  assert.match(warnMessageList[1], /SEEON_BUILD_TUNNEL_KEY/);
});

test('env 하나만 있으면 그 파일만 넣고 나머지 하나만 경고한다', () => {
  const { config, warnMessageList } = buildWith({ env: { SEEON_BUILD_TUNNEL_KEY: TUNNEL_KEY_PATH } });
  assert.deepEqual(config.extraResources, [{ from: TUNNEL_KEY_PATH, to: PACKAGED_KEY_FILE_NAME }, KIWI_RESOURCE]);
  assert.equal(warnMessageList.length, 1);
  assert.match(warnMessageList[0], /SEEON_BUILD_ENV_FILE/);
});

test('env 가 상대 경로면 빌드를 실행한 폴더 기준 절대 경로로 넣는다', () => {
  const absolutePath = path.resolve('keys/app-key');
  const { config } = buildWith({ env: { SEEON_BUILD_TUNNEL_KEY: 'keys/app-key' }, existingPathList: [absolutePath] });
  assert.deepEqual(config.extraResources, [{ from: absolutePath, to: PACKAGED_KEY_FILE_NAME }, KIWI_RESOURCE]);
});

test('env 에 적은 파일이 없으면 비밀이 빠진 설치 파일을 만들지 않고 멈춘다', () => {
  assert.throws(
    () => buildWith({ env: { SEEON_BUILD_ENV_FILE: '/typo/.env' } }),
    /SEEON_BUILD_ENV_FILE/,
  );
});

test('.env 에 주석·다른 키 줄이 있으면 개발 PC .env 를 그대로 넣지 않게 멈추고, 그 내용은 알리지 않는다', () => {
  const envText = '# GPU_SSH_PASSWORD=secret\nSEEON_ASR_LANGUAGE=ko\nOPENAI_API_KEY=sk-1\n';
  let message = '';
  try {
    buildWith({ env: { SEEON_BUILD_ENV_FILE: ENV_FILE_PATH }, envText });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /SEEON_BUILD_ENV_FILE/);
  assert.match(message, /2줄/);
  assert.doesNotMatch(message, /secret|sk-1|GPU_SSH_PASSWORD|OPENAI/);
});

test('Windows: x64 NSIS 한 번 클릭 설치, 사용자 단위, 바탕화면·시작 메뉴 바로가기, 설치 후 바로 실행', () => {
  const { config } = buildWith({ env: {} });
  assert.equal(config.productName, 'SEEON');
  assert.equal(config.appId, 'kr.seeon.meet');
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.createDesktopShortcut, 'always');
  assert.equal(config.nsis.createStartMenuShortcut, true);
  assert.equal(config.nsis.runAfterFinish, true);
  assert.equal(config.nsis.artifactName, 'SEEON-Setup-${version}.${ext}');
});

test('설치본 앱 이름을 SEEON 으로 두어 사용자 데이터 폴더도 SEEON 이 되고, exe 회사 이름도 SEEON 이다', () => {
  const { config } = buildWith({ env: {} });
  assert.deepEqual(config.extraMetadata, { productName: 'SEEON', author: { name: 'SEEON' } });
});

test('앱에는 src·package.json 만 넣고, 맥 전용 네이티브 빌드는 빼며, 네이티브 재빌드를 끈다', () => {
  const { config } = buildWith({ env: {} });
  assert.equal(config.npmRebuild, false);
  assert.equal(config.directories.output, 'dist');
  assert.ok(config.files.includes('src/**/*'));
  assert.ok(config.files.includes('package.json'));
  assert.ok(config.files.includes('!node_modules/cpu-features/build/**'));
  assert.ok(config.files.includes('!node_modules/ssh2/lib/protocol/crypto/build/**'));
  const includeList = config.files.filter((pattern) => !pattern.startsWith('!'));
  assert.deepEqual(includeList, ['src/**/*', 'package.json']);
});

test('터널이 쓰지 않는 ssh2 의 Pageant 실행 파일(pagent.exe)은 설치본에 넣지 않는다', () => {
  const { config } = buildWith({ env: {} });
  assert.ok(config.files.includes('!node_modules/ssh2/util/pagent.exe'));
});

test('electron-builder 가 부르는 기본 내보내기는 process.env 로 설정을 만든다', () => {
  const savedEnv = { envFile: process.env.SEEON_BUILD_ENV_FILE, tunnelKey: process.env.SEEON_BUILD_TUNNEL_KEY };
  delete process.env.SEEON_BUILD_ENV_FILE;
  delete process.env.SEEON_BUILD_TUNNEL_KEY;
  const warn = mock.method(console, 'warn', () => {});
  const originalExistsSync = fs.existsSync;
  mock.method(fs, 'existsSync', (filePath) => String(filePath).startsWith(DEV_KIWI_MODEL_DIR) || originalExistsSync(filePath));
  try {
    const config = loadBuilderConfig({ packageKey: 'build', configFilename: 'electron-builder', projectDir: '.' });
    assert.deepEqual(config.extraResources, [{ from: DEV_KIWI_MODEL_DIR, to: PACKAGED_KIWI_MODEL_DIR_NAME, filter: KIWI_MODEL_FILE_LIST }]);
    assert.equal(warn.mock.callCount(), 2);
  } finally {
    if (savedEnv.envFile !== undefined) process.env.SEEON_BUILD_ENV_FILE = savedEnv.envFile;
    if (savedEnv.tunnelKey !== undefined) process.env.SEEON_BUILD_TUNNEL_KEY = savedEnv.tunnelKey;
  }
});

test('Kiwi 모델이 없으면 한국어 트리거가 대체 규칙으로 떨어진 설치 파일을 만들지 않고 멈춘다', () => {
  assert.throws(
    () => createBuilderConfig({ env: {}, fileExists: () => false, warn: () => {}, kiwiModelDir: KIWI_MODEL_DIR }),
    /setup:kiwi/,
  );
});

test('Kiwi wasm 은 asar 밖에 풀어 둔다', () => {
  const { config } = buildWith({ env: {} });
  assert.deepEqual(config.asarUnpack, ['node_modules/kiwi-nlp/dist/*.wasm']);
});
