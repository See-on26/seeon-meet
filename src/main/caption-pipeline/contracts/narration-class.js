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

// AD 카드·내보내기의 코드. 아키텍처 에이전트(=재생 분류)마다 하나다. A 는 자동 AD, Q 는 질문 답(수동 AD)이다.
// A1~A5 는 결과보고서 생성 Layer 순서(페이지 전환 · 지시 대상 · 발화 기반 · 무발화 기반 · 화자 식별)를 따른다.
// 렌더러 core/constants.js 에 같은 사본이 있다(test/contracts-parity.test.mjs).
const AD_CODE_BY_CLASS_MAP = {
  [NARRATION_CLASS_MAP.pageTransition]: 'A1',
  [NARRATION_CLASS_MAP.deixis]: 'A2',
  [NARRATION_CLASS_MAP.speechBased]: 'A3',
  [NARRATION_CLASS_MAP.silenceBased]: 'A4',
  [NARRATION_CLASS_MAP.speakerIdentity]: 'A5',
  [NARRATION_CLASS_MAP.userCommand]: 'Q',
};

module.exports = { toNarrationClass, NARRATION_ORIGIN_MAP, AD_CODE_BY_CLASS_MAP };
