// 실험 창(녹화 영상을 production 화면에 넣어 돌리는 평가·시연 도구)의 Windows 설치본 설정.
// 제품 앱과 같은 코드·비밀(.env·터널 키)·Kiwi 모델을 묶고, 시작 파일과 앱 이름·appId·설치 이름만 나눠
// 한 PC 에 제품 SEEON 과 함께 설치할 수 있게 한다.
const { createBuilderConfig } = require('./electron-builder.config.js');

const LAB_PRODUCT_NAME = 'SEEON Lab';
const LAB_MAIN_PATH = 'src/main/lab/index.js';
// 사용자별 원클릭 설치에서 electron-builder 는 설치 폴더를 package.json name 으로 정한다(%LOCALAPPDATA%\Programs\<name>).
// 제품과 이름이 같으면 한 폴더에 깔려 나중에 깐 쪽 app.asar 만 남고, 두 바로가기가 모두 그 앱을 연다.
const LAB_PACKAGE_NAME = 'seeon-lab';
// 바탕화면에서 제품 SEEON(로고 아이콘)과 구분되게 실험 창은 남색 바탕 S 아이콘을 쓴다.
const LAB_ICON_PATH = 'build/icon-lab.png';

function createLabBuilderConfig(option) {
  const baseConfig = createBuilderConfig(option);
  return {
    ...baseConfig,
    appId: 'kr.seeon.lab',
    productName: LAB_PRODUCT_NAME,
    extraMetadata: { ...baseConfig.extraMetadata, main: LAB_MAIN_PATH, name: LAB_PACKAGE_NAME, productName: LAB_PRODUCT_NAME },
    win: { ...baseConfig.win, icon: LAB_ICON_PATH },
    mac: { ...baseConfig.mac, icon: LAB_ICON_PATH },
    nsis: { ...baseConfig.nsis, shortcutName: LAB_PRODUCT_NAME, artifactName: 'SEEON-Lab-Setup-${version}.${ext}' },
  };
}

// electron-builder 는 함수를 내보내면 불러서 설정을 받는다.
module.exports = () => createLabBuilderConfig();
module.exports.createLabBuilderConfig = createLabBuilderConfig;
