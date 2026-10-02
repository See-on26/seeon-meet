const { NARRATION_TYPE_MAP, NARRATION_CLASS_MAP } = require('./narration-types');

// 페이지 전환 캡션은 source 로 'page-transition' 문자열을 쓴다.
const PAGE_TRANSITION_SOURCE = 'page-transition';

const NARRATION_ORIGIN_MAP = {
  router: 'router',
  pageTransition: 'page_transition',
  silence: 'silence',
};

const CLASS_BY_TYPE_MAP = {
  [NARRATION_TYPE_MAP.pageTransition]: NARRATION_CLASS_MAP.pageTransition,
  [NARRATION_TYPE_MAP.deixis]: NARRATION_CLASS_MAP.deixis,
  [NARRATION_TYPE_MAP.interpretation]: NARRATION_CLASS_MAP.speechBased,
  [NARRATION_TYPE_MAP.userCommand]: NARRATION_CLASS_MAP.userCommand,
  [NARRATION_TYPE_MAP.speakerIdentity]: NARRATION_CLASS_MAP.speakerIdentity,
};

// 시각 묘사는 같은 에이전트가 세 경로에서 쓰인다: 라우터의 척도(발화 기반),
// 사진 단독 전환(페이지 전환에 딸림), 무발화.
const VISUAL_CLASS_BY_ORIGIN_MAP = {
  [NARRATION_ORIGIN_MAP.router]: NARRATION_CLASS_MAP.speechBased,
  [NARRATION_ORIGIN_MAP.pageTransition]: NARRATION_CLASS_MAP.pageTransition,
  [NARRATION_ORIGIN_MAP.silence]: NARRATION_CLASS_MAP.silenceBased,
};

function toNarrationClass({ narrationType, origin = NARRATION_ORIGIN_MAP.router }) {
  if (narrationType === PAGE_TRANSITION_SOURCE) return NARRATION_CLASS_MAP.pageTransition;
  if (narrationType === NARRATION_TYPE_MAP.visualDescription) {
    return VISUAL_CLASS_BY_ORIGIN_MAP[origin] || null;
  }
  return CLASS_BY_TYPE_MAP[narrationType] || null;
}

module.exports = { toNarrationClass, NARRATION_ORIGIN_MAP };
