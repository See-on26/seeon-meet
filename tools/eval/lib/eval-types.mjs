import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TRIGGER_TYPE_MAP } = require('../../../src/main/caption-pipeline/trigger/speech-trigger.js');

// 3.1 탐지 평가의 유형 6개. 값은 데이터셋의 targetType·positionList[].type 에 쓰는 글자 그대로다.
export const TARGET_TYPE_MAP = {
  demonstrative: 'demonstrative',
  adjectiveNoun: 'adjective_noun',
  value: 'value',
  change: 'change',
  scale: 'scale',
  silence: 'silence',
};

export const TARGET_TYPE_LIST = Object.values(TARGET_TYPE_MAP);

// 회의록 3.1 의 유형 번호.
export const TARGET_TYPE_CODE_MAP = {
  [TARGET_TYPE_MAP.demonstrative]: '2-1',
  [TARGET_TYPE_MAP.adjectiveNoun]: '2-2',
  [TARGET_TYPE_MAP.value]: '3-1',
  [TARGET_TYPE_MAP.change]: '3-2',
  [TARGET_TYPE_MAP.scale]: '3-3',
  [TARGET_TYPE_MAP.silence]: '4-1',
};

export const TARGET_TYPE_LABEL_MAP = {
  [TARGET_TYPE_MAP.demonstrative]: '지시대명사',
  [TARGET_TYPE_MAP.adjectiveNoun]: '형용사+지시 명사',
  [TARGET_TYPE_MAP.value]: '단순 수치',
  [TARGET_TYPE_MAP.change]: '변화·비교·결론',
  [TARGET_TYPE_MAP.scale]: '추상적 척도',
  [TARGET_TYPE_MAP.silence]: '무발화',
};

// 평가 셋 언어. 한국어는 형태소 분석 후 품사 단위로, 영어는 단어 경계(대소문자 무시)로 대조한다.
export const LANGUAGE_MAP = { ko: 'ko', en: 'en' };
export const LANGUAGE_LIST = Object.values(LANGUAGE_MAP);

// 해소 위치: 앞 발화에서 해소·뒤 발화에서 해소·해소 안 됨·경계 사례.
export const RESOLUTION_LIST = ['before', 'after', 'none', 'boundary'];

export const CANDIDATE_SOURCE_MAP = {
  production: 'production',
  methodology: 'methodology',
};

export const CANDIDATE_SOURCE_LIST = Object.values(CANDIDATE_SOURCE_MAP);

// 평가 유형 ↔ production 트리거 유형(main speech-trigger.js). 이름이 다른 것은 3-1 단순 수치(value ↔ number) 하나다.
// 무발화는 트리거 유형이 없다 — 라우터가 아니라 무발화 판정기가 정한다.
export const TRIGGER_TYPE_BY_TARGET_TYPE_MAP = {
  [TARGET_TYPE_MAP.demonstrative]: TRIGGER_TYPE_MAP.demonstrative,
  [TARGET_TYPE_MAP.adjectiveNoun]: TRIGGER_TYPE_MAP.adjectiveNoun,
  [TARGET_TYPE_MAP.value]: TRIGGER_TYPE_MAP.number,
  [TARGET_TYPE_MAP.change]: TRIGGER_TYPE_MAP.change,
  [TARGET_TYPE_MAP.scale]: TRIGGER_TYPE_MAP.scale,
};

export const TARGET_TYPE_BY_TRIGGER_TYPE_MAP = Object.fromEntries(
  Object.entries(TRIGGER_TYPE_BY_TARGET_TYPE_MAP).map(([targetType, triggerType]) => [triggerType, targetType]),
);

// --mode 로 고를 수 있는 모드. 평가 기본은 균형(delayed)이고, 성능(realtime_sic)은 맥락 창이 동시와 같아 따로 두지 않는다.
export const EVAL_MODE_LIST = ['delayed', 'realtime_mix', 'listening'];

export const QUESTION_CATEGORY_MAP = { piece: '조각', integrated: '통합' };

// 소분류마다 속하는 대분류(회의록 3.2.2).
export const QUESTION_SUBCATEGORY_CATEGORY_MAP = {
  '지시 대상 파악': QUESTION_CATEGORY_MAP.piece,
  '수치 의미 파악': QUESTION_CATEGORY_MAP.piece,
  '변화·비교 파악': QUESTION_CATEGORY_MAP.piece,
  '정도 파악': QUESTION_CATEGORY_MAP.piece,
  '교차 조회': QUESTION_CATEGORY_MAP.integrated,
  '교차 대조': QUESTION_CATEGORY_MAP.integrated,
};

export const UNKNOWN_CHOICE_TEXT = '알 수 없음';
