const { NARRATION_TYPE_MAP } = require('../contracts/narration-types');

// 수치·척도 프롬프트는 그림을 공유 중인 화면 전체로 안내한다. 가리킨 영역으로 자른 그림은 지시 해설만 받고,
// 수치·척도 에이전트와 그 같은 프레임 OCR 근거·값 검사 재전사는 전체 화면을 받는다. 영역이 없으면 받은 한 장을 함께 쓴다.
const SCREEN_FRAME_NARRATION_TYPE_SET = new Set([NARRATION_TYPE_MAP.interpretation, NARRATION_TYPE_MAP.visualDescription]);

function resolveDeixisFrameSet({ buffer, fullBuffer = null }) {
  const regionFrame = Buffer.from(buffer);
  const screenFrame = fullBuffer ? Buffer.from(fullBuffer) : regionFrame;
  return {
    screenFrame,
    selectAgentFrame: (narrationType) => (SCREEN_FRAME_NARRATION_TYPE_SET.has(narrationType) ? screenFrame : regionFrame),
  };
}

module.exports = { resolveDeixisFrameSet };
