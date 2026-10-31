import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveOutDir, OUT_DIR, SUMMARIES_DIR, FRAMES_DIR } = require('../src/main/paths.js');
const { resolveEnvFilePath, loadEnvFile, PACKAGED_ENV_FILE_NAME } = require('../src/main/env.js');

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_DATA_PATH = 'C:\\Users\\tester\\AppData\\Roaming\\SEEON';
const RESOURCES_PATH = 'C:\\Program Files\\SEEON\\resources';

function makeApp({ isPackaged }) {
  const getPathCallList = [];
  return {
    getPathCallList,
    isPackaged,
    getPath: (name) => {
      getPathCallList.push(name);
      return USER_DATA_PATH;
    },
  };
}

afterEach(() => { mock.restoreAll(); });

test('쓰기 폴더: 설치본은 app.asar 안에 쓸 수 없어 사용자 데이터 폴더의 out 을 쓴다', () => {
  const app = makeApp({ isPackaged: true });
  assert.equal(resolveOutDir({ app }), path.join(USER_DATA_PATH, 'out'));
  assert.deepEqual(app.getPathCallList, ['userData']);
});

test('쓰기 폴더: 개발 실행은 지금처럼 저장소 out/ 을 쓴다', () => {
  const app = makeApp({ isPackaged: false });
  assert.equal(resolveOutDir({ app }), path.join(REPO_ROOT, 'out'));
  assert.deepEqual(app.getPathCallList, []);
});

test('쓰기 폴더: electron 없이 node 로 불러도(app 없음) 저장소 out/ 으로 정해진다', () => {
  assert.equal(resolveOutDir({ app: undefined }), path.join(REPO_ROOT, 'out'));
  assert.equal(OUT_DIR, path.join(REPO_ROOT, 'out'));
  assert.equal(SUMMARIES_DIR, path.join(OUT_DIR, 'summaries'));
  assert.equal(FRAMES_DIR, path.join(OUT_DIR, 'frames'));
});

test('.env 경로: 설치본은 resources 폴더의 .env 를 읽는다', () => {
  assert.equal(PACKAGED_ENV_FILE_NAME, '.env');
  assert.equal(resolveEnvFilePath({ isPackaged: true, resourcesPath: RESOURCES_PATH }), path.join(RESOURCES_PATH, '.env'));
});

test('.env 경로: 개발 실행은 저장소 루트 .env 를 읽는다', () => {
  const repoEnvPath = path.join(REPO_ROOT, '.env');
  assert.equal(resolveEnvFilePath({ isPackaged: false, resourcesPath: RESOURCES_PATH }), repoEnvPath);
  assert.equal(resolveEnvFilePath({ isPackaged: true, resourcesPath: '' }), repoEnvPath);
  assert.equal(resolveEnvFilePath(), repoEnvPath);
});

test('.env 로드: 설치본이면 resources 의 .env 값을 환경변수로 올리고, 어디서 읽었는지 알린다', async () => {
  const resourcesPath = await mkdtemp(path.join(tmpdir(), 'seeon-resources-'));
  await writeFile(path.join(resourcesPath, PACKAGED_ENV_FILE_NAME), 'SEEON_PACKAGED_ENV_PROBE=from-resources\n', 'utf8');
  const log = mock.method(console, 'log', () => {});
  try {
    loadEnvFile({ isPackaged: true, resourcesPath });
    assert.equal(process.env.SEEON_PACKAGED_ENV_PROBE, 'from-resources');
    assert.equal(log.mock.callCount(), 1);
    assert.match(log.mock.calls[0].arguments[0], /\.env 로드됨.*resources/);
  } finally {
    delete process.env.SEEON_PACKAGED_ENV_PROBE;
    await rm(resourcesPath, { recursive: true, force: true });
  }
});

test('.env 로드: 설치본에 .env 가 없으면 조용히 넘어간다', async () => {
  const resourcesPath = await mkdtemp(path.join(tmpdir(), 'seeon-resources-'));
  const log = mock.method(console, 'log', () => {});
  const warn = mock.method(console, 'warn', () => {});
  try {
    loadEnvFile({ isPackaged: true, resourcesPath });
    assert.equal(log.mock.callCount(), 0);
    assert.equal(warn.mock.callCount(), 0);
  } finally {
    await rm(resourcesPath, { recursive: true, force: true });
  }
});
