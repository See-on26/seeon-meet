// 실험 창 배치: 왼쪽 60% 는 위 조작 바 + 아래 재생 화면, 오른쪽은 production 화면(viewer).
// 재생 화면 크기가 곧 캡처 해상도라서 평가 때는 창 크기를 고정하고 실행 정보에 남긴다.
const DEFAULT_WINDOW_SIZE = { width: 1920, height: 1080 };
const LEFT_COLUMN_RATIO = 0.6;
const CONTROL_BAR_HEIGHT = 64;
const WINDOW_SIZE_PATTERN = /^(\d{3,5})x(\d{3,5})$/;

function readWindowSize(env = process.env) {
  const match = WINDOW_SIZE_PATTERN.exec(String(env.SEEON_LAB_WINDOW || '').trim());
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { ...DEFAULT_WINDOW_SIZE };
}

function computeLabLayout({ width, height, leftRatio = LEFT_COLUMN_RATIO, controlHeight = CONTROL_BAR_HEIGHT }) {
  const leftWidth = Math.round(width * leftRatio);
  return {
    window: { width, height },
    control: { x: 0, y: 0, width: leftWidth, height: controlHeight },
    player: { x: 0, y: controlHeight, width: leftWidth, height: Math.max(0, height - controlHeight) },
    viewer: { x: leftWidth, y: 0, width: width - leftWidth, height },
  };
}

module.exports = { readWindowSize, computeLabLayout, DEFAULT_WINDOW_SIZE, LEFT_COLUMN_RATIO, CONTROL_BAR_HEIGHT };
