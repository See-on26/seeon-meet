const { NARRATION_CLASS_MAP } = require('../contracts/narration-types');

const {
  userCommand, pageTransition, speakerIdentity, silenceBased, speechBased, deixis,
} = NARRATION_CLASS_MAP;

// 재생 분류별 순위(숫자가 작을수록 중요하다). 페이지 전환과 화자 식별은 같은 순위다.
// 렌더러 재생 대기 줄(narration-queue.js)의 표와 같아야 한다 — 테스트가 둘을 비교한다.
const NARRATION_PRIORITY_MAP = {
  [userCommand]: 0,
  [pageTransition]: 1,
  [speakerIdentity]: 1,
  [silenceBased]: 2,
  [speechBased]: 3,
  [deixis]: 4,
};

// 발화 기반·지시 해설 간격. 필기·포인터로 가리킨 곳이 있으면 대상이 분명해 더 짧게 둔다.
const POINTED_MIN_INTERVAL_MS = 12000;
const SPEECH_ONLY_MIN_INTERVAL_MS = 18000;
// 페이지 전환 고지 직후 무발화 해설을 막는 간격. 무발화끼리는 silence-gate(60초·슬라이드당 1회)가 막는다.
const SILENCE_AFTER_TRANSITION_MIN_INTERVAL_MS = 12000;

// 차단 규칙 표. 행은 지금 들어온 해설의 분류, blockedByClassList 는 최근에 내보낸 해설 중 이 해설을 막는 분류다.
// - 안내(질문 답·페이지 전환·화자 안내)는 내용 해설을 막지 않는다. 안내가 막으면 슬라이드를 넘기거나
//   발화자가 바뀐 직후 발표자가 처음 가리키거나 설명하는 내용 해설이 빠진다.
//   예외로 페이지 전환 고지는 무발화 해설만 막는다: 고지가 막 그 화면을 묘사했기 때문이다.
//   사진 단독 전환의 반응 묘사도 페이지 전환 분류라 같은 규칙을 따른다.
// - 내용 해설(무발화·발화 기반·지시)은 순위가 같거나 낮은 내용 해설만 막는다(낮은 순위는 높은 순위를 막지 않는다).
// - null 행은 간격 검사를 받지 않는다(중복 억제는 따로 받는다).
// - 간격은 들어온 해설 행의 값이다. 가리킨 곳이 있으면 pointedMinIntervalMs, 없거나 값이 없으면 minIntervalMs.
const BLOCKING_RULE_MAP = {
  [userCommand]: null,
  [pageTransition]: null,
  [speakerIdentity]: null,
  [silenceBased]: {
    blockedByClassList: [pageTransition],
    minIntervalMs: SILENCE_AFTER_TRANSITION_MIN_INTERVAL_MS,
  },
  [speechBased]: {
    blockedByClassList: [silenceBased, speechBased],
    minIntervalMs: SPEECH_ONLY_MIN_INTERVAL_MS,
    pointedMinIntervalMs: POINTED_MIN_INTERVAL_MS,
  },
  [deixis]: {
    blockedByClassList: [silenceBased, speechBased, deixis],
    minIntervalMs: SPEECH_ONLY_MIN_INTERVAL_MS,
    pointedMinIntervalMs: POINTED_MIN_INTERVAL_MS,
  },
};

const BLOCKING_RELATION_MAP = {
  sameClass: 'same_class',
  samePriority: 'same_priority',
  higherPriority: 'higher_priority',
};

const BLOCKING_RELATION_LABEL_MAP = {
  [BLOCKING_RELATION_MAP.sameClass]: '같은 분류',
  [BLOCKING_RELATION_MAP.samePriority]: '같은 순위',
  [BLOCKING_RELATION_MAP.higherPriority]: '더 높은 순위',
};

const NARRATION_CLASS_LABEL_MAP = {
  [userCommand]: '질문 답',
  [pageTransition]: '페이지 전환',
  [speakerIdentity]: '화자 안내',
  [silenceBased]: '무발화',
  [speechBased]: '발화 기반',
  [deixis]: '지시',
};

// 분류가 빠졌거나 모르는 분류는 지시로 본다. 렌더러 readNarrationPriority 와 같은 규칙이다.
function normalizeNarrationClass({ narrationClass }) {
  return Number.isInteger(NARRATION_PRIORITY_MAP[narrationClass]) ? narrationClass : deixis;
}

function readNarrationPriority({ narrationClass }) {
  return NARRATION_PRIORITY_MAP[normalizeNarrationClass({ narrationClass })];
}

function findBlockingRule({ narrationClass }) {
  return BLOCKING_RULE_MAP[normalizeNarrationClass({ narrationClass })];
}

function resolveMinIntervalMs({ rule, hasPointingRegion = false }) {
  return hasPointingRegion && Number.isFinite(rule.pointedMinIntervalMs)
    ? rule.pointedMinIntervalMs : rule.minIntervalMs;
}

// 기록·로그에서 같은 분류끼리의 간격 억제와 더 중요한 해설 뒤의 억제를 가르기 위한 관계.
function readBlockingRelation({ narrationClass, blockedByClass }) {
  if (normalizeNarrationClass({ narrationClass }) === normalizeNarrationClass({ narrationClass: blockedByClass })) {
    return BLOCKING_RELATION_MAP.sameClass;
  }
  return readNarrationPriority({ narrationClass: blockedByClass }) < readNarrationPriority({ narrationClass })
    ? BLOCKING_RELATION_MAP.higherPriority : BLOCKING_RELATION_MAP.samePriority;
}

module.exports = {
  NARRATION_PRIORITY_MAP, BLOCKING_RULE_MAP, BLOCKING_RELATION_MAP, BLOCKING_RELATION_LABEL_MAP,
  NARRATION_CLASS_LABEL_MAP, POINTED_MIN_INTERVAL_MS, SPEECH_ONLY_MIN_INTERVAL_MS,
  SILENCE_AFTER_TRANSITION_MIN_INTERVAL_MS, normalizeNarrationClass, readNarrationPriority,
  findBlockingRule, resolveMinIntervalMs, readBlockingRelation,
};
