const fs = require('fs');
const path = require('path');
const { PACKAGED_ENV_FILE_NAME } = require('./src/main/env');
const { PACKAGED_KEY_FILE_NAME } = require('./src/main/gpu-tunnel/tunnel-config');
const {
  KIWI_MODEL_FILE_LIST, PACKAGED_KIWI_MODEL_DIR_NAME, DEV_KIWI_MODEL_DIR,
} = require('./src/main/caption-pipeline/trigger/kiwi-model');
const { countUnpackagedEnvLine } = require('./tools/windows-kit/packaged-env.cjs');

const PRODUCT_NAME = 'SEEON';

const BUILD_ENV_FILE_KEY = 'SEEON_BUILD_ENV_FILE';
const BUILD_TUNNEL_KEY_KEY = 'SEEON_BUILD_TUNNEL_KEY';

// 빌드 때 env 로 받아 설치본 resources 에 넣는 비밀 파일. 이름은 앱이 찾는 이름과 같아야 한다.
const SECRET_RESOURCE_LIST = [
  { envKey: BUILD_ENV_FILE_KEY, to: PACKAGED_ENV_FILE_NAME, missingNote: 'GPU 서버 접속 설정 없이 기본값으로 동작합니다', isEnvFile: true },
  { envKey: BUILD_TUNNEL_KEY_KEY, to: PACKAGED_KEY_FILE_NAME, missingNote: 'GPU 서버 터널을 직접 열지 못합니다' },
];

// 맥에서 빌드된 네이티브 바이너리는 Windows 에서 못 쓴다. ssh2 는 이것들 없이 순수 JS 로 동작한다.
const NATIVE_BINARY_EXCLUDE_LIST = [
  '!node_modules/cpu-features/build/**',
  '!node_modules/ssh2/lib/protocol/crypto/build/**',
];

// ssh2 가 Pageant(Windows SSH 에이전트) 연결에 쓰는 서명 없는 exe. 터널은 키 파일로 접속해 쓰지 않고, 백신 검사 대상만 늘린다.
const UNUSED_EXECUTABLE_EXCLUDE_LIST = [
  '!node_modules/ssh2/util/pagent.exe',
];

// 한국어 트리거의 Kiwi 모델. npm run setup:kiwi(dist 전에 자동)가 받는다. 없으면 한국어 트리거가 대체 규칙으로 떨어지므로 만들지 않고 멈춘다.
function buildKiwiModelResource({ fileExists, modelDir = DEV_KIWI_MODEL_DIR }) {
  const missingList = KIWI_MODEL_FILE_LIST.filter((name) => !fileExists(path.join(modelDir, name)));
  if (missingList.length) {
    throw new Error(`[dist] Kiwi 모델이 없습니다(${missingList.join(', ')}) — npm run setup:kiwi 를 먼저 실행하세요`);
  }
  return { from: modelDir, to: PACKAGED_KIWI_MODEL_DIR_NAME, filter: KIWI_MODEL_FILE_LIST };
}

// .env 는 앱이 읽는 SEEON_ 설정 줄만 담겨 있어야 넣는다. 주석·다른 키 줄이 있으면 개발 PC .env 를 그대로 넘긴 것이라
// (주석에 적어 둔 접속 정보까지 들어간다) 만들지 않고 멈춘다. 키트(npm run dist:win:kit)는 걸러 낸 파일을 넘긴다.
function assertPackagedEnvFile({ envKey, text }) {
  const lineCount = countUnpackagedEnvLine(text);
  if (lineCount) {
    throw new Error(`[dist] ${envKey} 파일에 설치본에 넣지 않는 줄(주석·다른 키·여러 줄 값)이 ${lineCount}줄 있습니다`
      + ' — npm run dist:win:kit 으로 만들거나 SEEON_ 설정 줄만 남긴 파일을 쓰세요');
  }
}

// 비밀 파일 내용과 경로는 로그에 남기지 않는다. env 를 적었는데 파일이 없으면 비밀 빠진 설치 파일을 만들지 않고 멈춘다.
function buildSecretResourceList({ env, fileExists, readFile, warn }) {
  const resourceList = [];
  for (const { envKey, to, missingNote, isEnvFile } of SECRET_RESOURCE_LIST) {
    if (!env[envKey]) {
      warn(`[dist] ${envKey} 가 비어 있어 ${to} 없이 만듭니다 — 설치본은 ${missingNote}`);
      continue;
    }
    const sourcePath = path.resolve(env[envKey]);
    if (!fileExists(sourcePath)) throw new Error(`[dist] ${envKey} 에 적은 파일을 찾지 못했습니다`);
    if (isEnvFile) assertPackagedEnvFile({ envKey, text: readFile(sourcePath, 'utf8') });
    resourceList.push({ from: sourcePath, to });
  }
  return resourceList;
}

function createBuilderConfig({
  env = process.env, fileExists = fs.existsSync, readFile = fs.readFileSync, warn = console.warn,
  kiwiModelDir = DEV_KIWI_MODEL_DIR,
} = {}) {
  return {
    appId: 'kr.seeon.meet',
    productName: PRODUCT_NAME,
    // 앱 이름(app.getName)·사용자 데이터 폴더 이름은 asar 안 package.json 의 productName 을 따른다.
    // author 가 없으면 exe 회사 이름·설치 정보 게시자가 Electron 기본값(GitHub, Inc.)으로 남는다.
    extraMetadata: { productName: PRODUCT_NAME, author: { name: PRODUCT_NAME } },
    directories: { output: 'dist', buildResources: 'build' },
    files: ['src/**/*', 'package.json', ...NATIVE_BINARY_EXCLUDE_LIST, ...UNUSED_EXECUTABLE_EXCLUDE_LIST],
    npmRebuild: false,
    // Kiwi wasm 은 asar 밖에 풀어 두고 읽는다(src/main/caption-pipeline/trigger/kiwi-tokenizer.js).
    asarUnpack: ['node_modules/kiwi-nlp/dist/*.wasm'],
    extraResources: [
      ...buildSecretResourceList({ env, fileExists, readFile, warn }),
      buildKiwiModelResource({ fileExists, modelDir: kiwiModelDir }),
    ],
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      // 설치 파일·바로가기·창 제목 줄 아이콘. 크기별(16~256px)로 다듬은 ICO 라 작은 크기에서도 둥근 모서리가 깔끔하다.
      icon: 'build/icon.ico',
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      shortcutName: PRODUCT_NAME,
      runAfterFinish: true,
      artifactName: 'SEEON-Setup-${version}.${ext}',
    },
    mac: {
      target: [{ target: 'dir' }],
      icon: 'build/icon.png',
      // 맥 패키지는 동작 확인용이라 서명하지 않는다.
      identity: null,
    },
  };
}

// electron-builder 는 함수를 내보내면 불러서 설정을 받는다.
module.exports = () => createBuilderConfig();
module.exports.createBuilderConfig = createBuilderConfig;
module.exports.BUILD_ENV_FILE_KEY = BUILD_ENV_FILE_KEY;
module.exports.BUILD_TUNNEL_KEY_KEY = BUILD_TUNNEL_KEY_KEY;
