const path = require('path');

// 한국어 트리거는 글자가 아니라 형태소 분석(Kiwi) 뒤 품사 단위로 맞춘다. 평가 DB(탐지 평가 DB)도 같은 Kiwi 버전으로 만들었다.
// npm 패키지 kiwi-nlp 와 모델 파일 버전은 함께 바꾼다.
const KIWI_MODEL_VERSION = '0.24.0';
const KIWI_MODEL_ARCHIVE_URL = `https://github.com/bab2min/Kiwi/releases/download/v${KIWI_MODEL_VERSION}/kiwi_model_v${KIWI_MODEL_VERSION}_base.tgz`;

// 기본 모델 중 분석에 꼭 필요한 파일만 쓴다(약 87MB). 오타·다의어·방언 사전은 회의 전사 분석에 쓰지 않는다.
const KIWI_MODEL_FILE_LIST = ['sj.morph', 'cong.mdl', 'combiningRule.txt', 'extract.mdl', 'default.dict'];

const PACKAGED_KIWI_MODEL_DIR_NAME = 'kiwi-model';
const DEV_KIWI_MODEL_DIR = path.join(__dirname, '..', '..', '..', '..', 'vendor', PACKAGED_KIWI_MODEL_DIR_NAME);

// 설치본은 resources/kiwi-model, 개발 실행은 저장소 vendor/kiwi-model (npm run setup:kiwi 가 받는다).
function resolveKiwiModelDir({ isPackaged = false, resourcesPath = '' } = {}) {
  return isPackaged && resourcesPath ? path.join(resourcesPath, PACKAGED_KIWI_MODEL_DIR_NAME) : DEV_KIWI_MODEL_DIR;
}

module.exports = {
  KIWI_MODEL_VERSION, KIWI_MODEL_ARCHIVE_URL, KIWI_MODEL_FILE_LIST,
  PACKAGED_KIWI_MODEL_DIR_NAME, DEV_KIWI_MODEL_DIR, resolveKiwiModelDir,
};
