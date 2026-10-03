const { NARRATION_CLASS_MAP } = require('../contracts/narration-types');

const KNOWN_CLASS_LIST = Object.values(NARRATION_CLASS_MAP);

// 사용자가 끈 재생 분류(C15). 렌더러 토글 저장소가 바뀔 때마다 알려 준다.
// 꺼진 분류도 맥락 저장소 기록은 남기고 캡션만 내보내지 않는다.
function createFeatureGate() {
  let disabledClassList = [];
  return {
    setDisabledClassList(classList) {
      disabledClassList = Array.isArray(classList)
        ? [...new Set(classList.filter((narrationClass) => KNOWN_CLASS_LIST.includes(narrationClass)))]
        : [];
    },
    isEnabled: (narrationClass) => !disabledClassList.includes(narrationClass),
    getDisabledClassList: () => [...disabledClassList],
  };
}

module.exports = { createFeatureGate };
