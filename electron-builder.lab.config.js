// 실험 창(녹화 영상을 production 화면에 넣어 돌리는 평가·시연 도구)의 Windows 설치본 설정.
// 제품 앱과 같은 코드·비밀(.env·터널 키)·Kiwi 모델을 묶고, 시작 파일과 앱 이름·appId·설치 이름만 나눠
// 한 PC 에 제품 SEEON 과 함께 설치할 수 있게 한다.
const { createBuilderConfig } = require('./electron-builder.config.js');

const LAB_PRODUCT_NAME = 'SEEON Lab';
const LAB_MAIN_PATH = 'src/main/lab/index.js';

function createLabBuilderConfig(option) {
  const baseConfig = createBuilderConfig(option);
  return {
    ...baseConfig,
    appId: 'kr.seeon.lab',
    productName: LAB_PRODUCT_NAME,
    extraMetadata: { ...baseConfig.extraMetadata, main: LAB_MAIN_PATH, productName: LAB_PRODUCT_NAME },
    nsis: { ...baseConfig.nsis, shortcutName: LAB_PRODUCT_NAME, artifactName: 'SEEON-Lab-Setup-${version}.${ext}' },
  };
}

// electron-builder 는 함수를 내보내면 불러서 설정을 받는다.
module.exports = () => createLabBuilderConfig();
module.exports.createLabBuilderConfig = createLabBuilderConfig;
