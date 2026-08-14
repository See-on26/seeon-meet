const path = require('path');

const ENV_FILE_PATH = path.join(__dirname, '..', '..', '.env');

function loadEnvFile() {
  try {
    process.loadEnvFile(ENV_FILE_PATH);
    console.log('[env] .env 로드됨');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[env] .env 로드 실패:', error.message);
  }
}

module.exports = { loadEnvFile };
