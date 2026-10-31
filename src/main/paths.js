const path = require('path');

const OUT_DIR_NAME = 'out';
const DEV_OUT_DIR = path.join(__dirname, '..', '..', OUT_DIR_NAME);

// 설치본은 app.asar 안에 쓸 수 없어 사용자 데이터 폴더에 쓴다. 개발 실행은 저장소 out/ 그대로.
function resolveOutDir({ app }) {
  return app?.isPackaged ? path.join(app.getPath('userData'), OUT_DIR_NAME) : DEV_OUT_DIR;
}

// electron 밖(node 테스트)에서 require('electron') 은 실행 파일 경로 문자열이라 app 이 없다.
function readElectronApp() {
  try {
    return require('electron').app;
  } catch {
    return undefined;
  }
}

const OUT_DIR = resolveOutDir({ app: readElectronApp() });
const FRAMES_DIR = path.join(OUT_DIR, 'frames');
const ROI_LOG = path.join(OUT_DIR, 'roi-log.jsonl');

const DEIXIS_FRAMES_DIR = path.join(OUT_DIR, 'deixis-frames');
const DEIXIS_NARRATED_DIR = path.join(DEIXIS_FRAMES_DIR, '내레이션 생성');
const DEIXIS_SKIPPED_DIR = path.join(DEIXIS_FRAMES_DIR, '내레이션 미생성');

const SLIDES_DIR = path.join(OUT_DIR, 'slides');

const SUMMARIES_DIR = path.join(OUT_DIR, 'summaries');

const CONTEXT_DIR = path.join(OUT_DIR, 'context');

// 그래프 어림(SEEON_CHART_ESTIMATE log·on)에 쓴 전체 화면 프레임. 어림값이 맞는지 사람이 나중에 눈으로 확인한다.
const CHART_FRAMES_DIR = path.join(OUT_DIR, 'chart-frames');

function resolveSlideDir({ sessionId, major }) {
  const slideDirName = `slide-${major}`;
  return sessionId
    ? path.join(SLIDES_DIR, sessionId, slideDirName)
    : path.join(SLIDES_DIR, slideDirName);
}

module.exports = {
  resolveOutDir, OUT_DIR, FRAMES_DIR, ROI_LOG,
  DEIXIS_FRAMES_DIR, DEIXIS_NARRATED_DIR, DEIXIS_SKIPPED_DIR,
  SLIDES_DIR, SUMMARIES_DIR, resolveSlideDir, CONTEXT_DIR, CHART_FRAMES_DIR,
};
