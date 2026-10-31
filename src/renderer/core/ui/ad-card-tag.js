import { NARRATION_TYPE_MAP, NARRATION_CLASS_MAP, AD_CODE_BY_CLASS_MAP } from '../constants.js';

// 해설 카드의 코드 배지와 라벨(ui-text 키)을 재생 분류로 고른다. 재생 분류가 아키텍처 에이전트와 1:1이라
// 같은 시각 묘사도 경로에 따라 발화 기반(척도) · 무발화 기반 · 페이지 전환(사진 단독 화면)으로 나뉜다.
const CARD_LABEL_KEY_BY_CLASS_MAP = {
  [NARRATION_CLASS_MAP.pageTransition]: 'card.pageTransition',
  [NARRATION_CLASS_MAP.deixis]: 'card.deixis',
  [NARRATION_CLASS_MAP.speechBased]: 'card.speechBased',
  [NARRATION_CLASS_MAP.silenceBased]: 'card.silenceBased',
  [NARRATION_CLASS_MAP.speakerIdentity]: 'card.speakerIdentity',
  [NARRATION_CLASS_MAP.screenChange]: 'card.screenChange',
  [NARRATION_CLASS_MAP.userCommand]: 'card.userCommand',
};

// 재생 분류가 없는 캡션만 source 로 분류를 찾는다. 페이지 전환 고지는 옛 문자열 'page-transition' 을 쓴다.
// 시각 묘사는 source 만으로 경로를 알 수 없어 넣지 않는다(기본 카드).
const CLASS_BY_SOURCE_MAP = {
  'page-transition': NARRATION_CLASS_MAP.pageTransition,
  [NARRATION_TYPE_MAP.pageTransition]: NARRATION_CLASS_MAP.pageTransition,
  [NARRATION_TYPE_MAP.deixis]: NARRATION_CLASS_MAP.deixis,
  [NARRATION_TYPE_MAP.interpretation]: NARRATION_CLASS_MAP.speechBased,
  [NARRATION_TYPE_MAP.speakerIdentity]: NARRATION_CLASS_MAP.speakerIdentity,
  [NARRATION_TYPE_MAP.userCommand]: NARRATION_CLASS_MAP.userCommand,
  [NARRATION_TYPE_MAP.screenChange]: NARRATION_CLASS_MAP.screenChange,
};

export const DEFAULT_AD_CARD_TAG = Object.freeze({ aid: '·', labelKey: 'card.default' });

export function resolveAdCardTag({ narrationClass = null, source = null } = {}) {
  const resolvedClass = narrationClass || CLASS_BY_SOURCE_MAP[source];
  const aid = AD_CODE_BY_CLASS_MAP[resolvedClass];
  if (!aid) return DEFAULT_AD_CARD_TAG;
  return { aid, labelKey: CARD_LABEL_KEY_BY_CLASS_MAP[resolvedClass] };
}
