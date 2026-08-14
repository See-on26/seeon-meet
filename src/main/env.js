const path = require('path');

// 설치본은 빌드 때 넣은 .env 를 resources 폴더에 이 이름으로 둔다.
const PACKAGED_ENV_FILE_NAME = '.env';
const DEV_ENV_FILE_PATH = path.join(__dirname, '..', '..', '.env');

function resolveEnvFilePath({ isPackaged = false, resourcesPath = '' } = {}) {
  return isPackaged && resourcesPath ? path.join(resourcesPath, PACKAGED_ENV_FILE_NAME) : DEV_ENV_FILE_PATH;
}

function loadEnvFile({ isPackaged = false, resourcesPath = '' } = {}) {
  const envFilePath = resolveEnvFilePath({ isPackaged, resourcesPath });
  try {
    process.loadEnvFile(envFilePath);
    console.log(envFilePath === DEV_ENV_FILE_PATH ? '[env] .env 로드됨' : '[env] .env 로드됨 (설치본 resources)');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[env] .env 로드 실패:', error.message);
  }
}

module.exports = { loadEnvFile, resolveEnvFilePath, PACKAGED_ENV_FILE_NAME };
