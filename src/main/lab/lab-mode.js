// 실험 창 main 이 쓰는 모드 값. 렌더러 ESM(mode-policy.js·narration-queue.js)을 main 에서 불러올 수 없어 값만 옮겨 두고,
// 같은 값인지는 lab-mode 테스트가 렌더러 모듈과 대조한다.
const LAB_MODE_MAP = {
  listening: 'listening',
  delayed: 'delayed',
  realtimeSic: 'realtime_sic',
  realtimeMix: 'realtime_mix',
};

const LAB_MODE_LIST = Object.values(LAB_MODE_MAP);

// 모드마다 회의 소리를 늦춰 트는 시간(mode-policy.js delayMs). 제품 개발자 흐름 창과 같은 공용 값을 쓴다.
const { MODE_DELAY_MS_MAP } = require('../dev-flow/mode-delay');

// 동시 모드만 회의 소리를 멈추지 않고 해설을 겹쳐 튼다(mode-policy.js isMixed).
const MIXED_MODE_LIST = [LAB_MODE_MAP.realtimeMix];

// 재생 대기 줄 TTL(narration-queue.js NARRATION_QUEUE_TTL_MS).
const NARRATION_QUEUE_TTL_MS = 8000;

// 팀 결정: 성능 평가는 교차 출력의 균형 모드로 한다. 평가 설정을 켜면 이 모드로 시작한다.
const EVAL_PRESET_MODE = LAB_MODE_MAP.delayed;
const DEFAULT_LAB_MODE = LAB_MODE_MAP.realtimeMix;

const LAB_MODE_LABEL_MAP = {
  [LAB_MODE_MAP.listening]: '품질',
  [LAB_MODE_MAP.delayed]: '균형',
  [LAB_MODE_MAP.realtimeSic]: '성능',
  [LAB_MODE_MAP.realtimeMix]: '동시',
};

function isCrossMode(mode) {
  return LAB_MODE_LIST.includes(mode) && !MIXED_MODE_LIST.includes(mode);
}

// 사용자가 모드를 고르지 않았으면 평가 설정에 따라 정한다.
function resolveRunMode({ requestedMode = null, isEvalPreset }) {
  if (LAB_MODE_LIST.includes(requestedMode)) return requestedMode;
  return isEvalPreset ? EVAL_PRESET_MODE : DEFAULT_LAB_MODE;
}

module.exports = {
  LAB_MODE_MAP, LAB_MODE_LIST, MODE_DELAY_MS_MAP, MIXED_MODE_LIST, NARRATION_QUEUE_TTL_MS,
  EVAL_PRESET_MODE, DEFAULT_LAB_MODE, LAB_MODE_LABEL_MAP, isCrossMode, resolveRunMode,
};
