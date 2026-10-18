const { NARRATION_TYPE_MAP, NARRATION_CLASS_MAP } = require('../caption-pipeline/contracts/narration-types');
const { AD_CODE_BY_CLASS_MAP } = require('../caption-pipeline/contracts/narration-class');

// 실험실 내보내기 aid 와 시연 배지는 viewer 카드와 같은 아키텍처 기준(재생 분류)으로 고른다.
const AD_LABEL_BY_CLASS_MAP = {
  [NARRATION_CLASS_MAP.pageTransition]: '페이지 전환',
  [NARRATION_CLASS_MAP.deixis]: '지시 대상',
  [NARRATION_CLASS_MAP.speechBased]: '발화 기반',
  [NARRATION_CLASS_MAP.silenceBased]: '무발화 기반',
  [NARRATION_CLASS_MAP.speakerIdentity]: '화자 식별',
  [NARRATION_CLASS_MAP.userCommand]: '질문 답',
};

// 재생 분류가 없는 옛 기록만 해설 유형으로 분류를 찾는다. 시각 묘사는 유형만으로 경로(척도·무발화·사진 단독)를 알 수 없어 넣지 않는다.
const CLASS_BY_TYPE_MAP = {
  [NARRATION_TYPE_MAP.pageTransition]: NARRATION_CLASS_MAP.pageTransition,
  [NARRATION_TYPE_MAP.deixis]: NARRATION_CLASS_MAP.deixis,
  [NARRATION_TYPE_MAP.interpretation]: NARRATION_CLASS_MAP.speechBased,
  [NARRATION_TYPE_MAP.speakerIdentity]: NARRATION_CLASS_MAP.speakerIdentity,
  [NARRATION_TYPE_MAP.userCommand]: NARRATION_CLASS_MAP.userCommand,
};

function resolveAdClass({ narrationClass = null, type = null }) {
  return narrationClass || CLASS_BY_TYPE_MAP[type] || null;
}

function resolveAdCode({ narrationClass = null, type = null }) {
  return AD_CODE_BY_CLASS_MAP[resolveAdClass({ narrationClass, type })] || null;
}

function resolveAdLabel({ narrationClass = null, type = null }) {
  return AD_LABEL_BY_CLASS_MAP[resolveAdClass({ narrationClass, type })] || null;
}

module.exports = { resolveAdCode, resolveAdLabel, AD_LABEL_BY_CLASS_MAP };
