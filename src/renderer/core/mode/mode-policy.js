import {
  NARRATION_TYPE_MAP, PAGE_TRANSITION_KIND_MAP, DEIXIS_FORM_MAP,
  INTERPRETATION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP, SPEAKER_IDENTITY_KIND_MAP,
  USER_COMMAND_MAP,
} from '../constants.js';

export const MODE_MAP = {
  listening: 'listening',
  delayed: 'delayed',
  realtimeSic: 'realtime_sic',
  realtimeMix: 'realtime_mix',
};

export const IS_DELAY_BUFFER_ENABLED = true;

export const DWELL_MS = 3000;

const SPEECH_MS_PER_WORD = 450;

const CONTEXT_BEFORE_MS = 60000;

const CONTEXT_AFTER_LISTENING_MS = 30000;
const CONTEXT_AFTER_DELAYED_MS = 7000;
const CONTEXT_AFTER_REALTIME_MS = 2000;

// 판단 LLM 의 앞 문맥은 모든 모드에서 마지막 화면 전환 이후의 발화(최대 60초)다(「성능 평가 방식」 1.3).
// window 는 화면 전환과 관계없이 최근 60초를 쓰던 방식으로, 다른 화면에서 한 말이 섞인다.
export const CONTEXT_ANCHOR_MAP = {
  screenTransition: 'screen_transition',
  window: 'window',
};

export const LOOKAHEAD_MAX_MS = 2500;

const ASR_SEGMENT_REALTIME_MS = 2500;
const ASR_SEGMENT_DELAYED_MS = 3000;
const ASR_SEGMENT_LISTENING_MS = 10000;

// 무음 절단 최소 길이. 최대 길이와 같으면 무음 판정보다 타이머가 먼저 끊어 말 도중에 잘린다.
const ASR_MIN_SEGMENT_REALTIME_MS = 1500;
const ASR_MIN_SEGMENT_CROSS_MS = 2500;

// 지시 후보의 look-ahead 가 끝났는데 문장이 안 끝났으면 더 기다리는 상한.
// 동시·성능 모드는 look-ahead(2초)가 다음 청크 도착(약 3초)보다 짧아 뒤 조각을 놓친다.
// 균형·품질 모드는 보류 시간이 뒤 맥락을 이미 모으므로 기다리지 않는다.
const SENTENCE_WAIT_REALTIME_MS = 1500;
const SENTENCE_WAIT_CROSS_MS = 0;

export const PIPELINE_LATENCY_MARGIN_MS = 2000;

export const MODE_POLICY_MAP = {
  [MODE_MAP.listening]: {
    delayMs: 60000, maxNarrationMs: 12000, rateMin: 1.0, rateMax: 1.1,
    contextAnchor: CONTEXT_ANCHOR_MAP.screenTransition,
    beforeMs: CONTEXT_BEFORE_MS, afterMs: CONTEXT_AFTER_LISTENING_MS,
    asrSegmentMs: ASR_SEGMENT_LISTENING_MS,
    asrMinSegmentMs: ASR_MIN_SEGMENT_CROSS_MS,
    sentenceWaitMs: SENTENCE_WAIT_CROSS_MS,
    isSwitchableFrom: false, isSpeculative: false, isMixed: false,
  },
  [MODE_MAP.delayed]: {
    delayMs: 10000, maxNarrationMs: 6000, rateMin: 1.1, rateMax: 1.5,
    contextAnchor: CONTEXT_ANCHOR_MAP.screenTransition,
    beforeMs: CONTEXT_BEFORE_MS, afterMs: CONTEXT_AFTER_DELAYED_MS,
    asrSegmentMs: ASR_SEGMENT_DELAYED_MS,
    asrMinSegmentMs: ASR_MIN_SEGMENT_CROSS_MS,
    sentenceWaitMs: SENTENCE_WAIT_CROSS_MS,
    isSwitchableFrom: false, isSpeculative: false, isMixed: false,
  },
  [MODE_MAP.realtimeSic]: {
    delayMs: 0, maxNarrationMs: 3000, rateMin: 1.5, rateMax: 1.8,
    contextAnchor: CONTEXT_ANCHOR_MAP.screenTransition,
    beforeMs: CONTEXT_BEFORE_MS, afterMs: CONTEXT_AFTER_REALTIME_MS,
    asrSegmentMs: ASR_SEGMENT_REALTIME_MS,
    asrMinSegmentMs: ASR_MIN_SEGMENT_REALTIME_MS,
    sentenceWaitMs: SENTENCE_WAIT_REALTIME_MS,
    isSwitchableFrom: true, isSpeculative: true, isMixed: false,
  },
  [MODE_MAP.realtimeMix]: {
    delayMs: 0, maxNarrationMs: 6000, rateMin: 1.0, rateMax: 1.0,
    contextAnchor: CONTEXT_ANCHOR_MAP.screenTransition,
    beforeMs: CONTEXT_BEFORE_MS, afterMs: CONTEXT_AFTER_REALTIME_MS,
    asrSegmentMs: ASR_SEGMENT_REALTIME_MS,
    asrMinSegmentMs: ASR_MIN_SEGMENT_REALTIME_MS,
    sentenceWaitMs: SENTENCE_WAIT_REALTIME_MS,
    isSwitchableFrom: true, isSpeculative: true, isMixed: true,
  },
};

const ANSWER_MIN_WORD_COUNT = 3;

// 사용자가 직접 물은 질문의 답 길이 상한. 답은 회의를 멈추지 않고 겹쳐 들려주므로 모드와 관계없이
// 15초 미만으로 맞춘다(TTS 어절당 약 0.45초 → 30어절 약 13초).
export const ANSWER_MAX_WORD_COUNT = 30;

export function computeAnswerWordBudget() {
  return {
    minWordCount: ANSWER_MIN_WORD_COUNT,
    maxWordCount: ANSWER_MAX_WORD_COUNT,
    isDroppable: false,
  };
}

export const NARRATION_WORD_RANGE_MAP = {
  [NARRATION_TYPE_MAP.pageTransition]: {
    [PAGE_TRANSITION_KIND_MAP.slide]: { minWordCount: 6, maxWordCount: 9 },
    [PAGE_TRANSITION_KIND_MAP.document]: { minWordCount: 6, maxWordCount: 9 },
  },
  // 지시 해설은 대상 내용만 읽는다. 상품 이름(2어절)부터 번호 넷의 띄어쓰기 비교(10어절 남짓)까지 들어가게 둔다.
  [NARRATION_TYPE_MAP.deixis]: {
    [DEIXIS_FORM_MAP.simple]: { minWordCount: 2, maxWordCount: 10 },
    [DEIXIS_FORM_MAP.complete]: { minWordCount: 4, maxWordCount: 12 },
  },
  [NARRATION_TYPE_MAP.interpretation]: {
    [INTERPRETATION_KIND_MAP.valueToMeaning]: { minWordCount: 6, maxWordCount: 12 },
    [INTERPRETATION_KIND_MAP.claimToValue]: { minWordCount: 6, maxWordCount: 12 },
  },
  [NARRATION_TYPE_MAP.visualDescription]: {
    [VISUAL_DESCRIPTION_KIND_MAP.reaction]: { minWordCount: 5, maxWordCount: 12 },
    // 척도는 크기 묘사 한 구(caption)다. "어른 손바닥만 한 사과"(3어절)부터 측정값 묘사까지 받는다.
    [VISUAL_DESCRIPTION_KIND_MAP.scale]: { minWordCount: 3, maxWordCount: 10 },
  },
  [NARRATION_TYPE_MAP.speakerIdentity]: {
    [SPEAKER_IDENTITY_KIND_MAP.named]: { minWordCount: 2, maxWordCount: 3 },
    [SPEAKER_IDENTITY_KIND_MAP.positional]: { minWordCount: 3, maxWordCount: 5 },
  },
  [NARRATION_TYPE_MAP.userCommand]: {
    [USER_COMMAND_MAP.screenMaterial]: { minWordCount: 6, maxWordCount: 15 },
    [USER_COMMAND_MAP.pageSummary]: { minWordCount: 6, maxWordCount: 25 },
    [USER_COMMAND_MAP.graphAxis]: { minWordCount: 6, maxWordCount: 15 },
  },
};

export function getModePolicy({ mode }) {
  return MODE_POLICY_MAP[mode] || null;
}

export function computeLookaheadMs({ mode }) {
  const policy = getModePolicy({ mode });
  if (!policy) return 0;
  return Math.min(policy.afterMs, LOOKAHEAD_MAX_MS);
}

export function computeSentenceWaitMs({ mode }) {
  return getModePolicy({ mode })?.sentenceWaitMs ?? 0;
}

export function computeContextHoldMs({ mode }) {
  const policy = getModePolicy({ mode });
  if (!policy || policy.delayMs <= 0) return 0;
  const lookaheadMs = computeLookaheadMs({ mode });
  const wantedMs = policy.afterMs - lookaheadMs;

  const affordableMs = policy.delayMs - policy.asrSegmentMs - lookaheadMs - PIPELINE_LATENCY_MARGIN_MS;
  return Math.max(0, Math.min(wantedMs, affordableMs));
}

export function resolveBeforeAnchorTs({ mode, screenTransitionTs = null }) {
  const policy = getModePolicy({ mode });
  if (!policy || policy.contextAnchor !== CONTEXT_ANCHOR_MAP.screenTransition) return null;
  return Number.isFinite(screenTransitionTs) ? screenTransitionTs : null;
}

export function computeSpeechDurationMs({ wordCount }) {
  return Math.max(0, wordCount) * SPEECH_MS_PER_WORD;
}

export function computeWordCountFromDurationMs({ durationMs }) {
  if (!(durationMs > 0)) return 0;
  return Math.floor(durationMs / SPEECH_MS_PER_WORD);
}

export function getWordRange({ narrationType, subKind = null }) {
  const rangeMap = NARRATION_WORD_RANGE_MAP[narrationType];
  if (!rangeMap) return null;
  if (subKind && rangeMap[subKind]) return rangeMap[subKind];
  const rangeList = Object.values(rangeMap);
  if (!rangeList.length) return null;
  return {
    minWordCount: Math.min(...rangeList.map((range) => range.minWordCount)),
    maxWordCount: Math.max(...rangeList.map((range) => range.maxWordCount)),
  };
}

export function computeAvailableMs({ mode, currentDelayMs = 0 }) {
  const policy = getModePolicy({ mode });
  if (!policy) return 0;
  if (policy.delayMs <= 0) return policy.maxNarrationMs;
  const remainingDelayMs = Math.max(0, policy.delayMs - currentDelayMs);
  return Math.min(policy.maxNarrationMs, remainingDelayMs);
}

export function computeWordBudget({ mode, narrationType, subKind = null, currentDelayMs = 0 }) {
  const range = getWordRange({ narrationType, subKind });
  if (!range) return { minWordCount: 0, maxWordCount: 0, isDroppable: true };
  return computeWordBudgetInRange({ mode, range, currentDelayMs });
}

// 무발화 해설은 발표자가 화면을 보라며 말없이 기다려 주는 자리라 사진 반응 해설(최대 12어절)보다 길게 둔다.
// 구조도는 구성 요소와 연결 관계까지 말해야 해서 머리말("이미지 제시,") 2어절 + 묘사 12어절이다.
export const SILENCE_DESCRIPTION_WORD_RANGE = { minWordCount: 5, maxWordCount: 14 };

export function computeSilenceWordBudget({ mode, currentDelayMs = 0 }) {
  return computeWordBudgetInRange({ mode, range: SILENCE_DESCRIPTION_WORD_RANGE, currentDelayMs });
}

function computeWordBudgetInRange({ mode, range, currentDelayMs }) {
  const availableMs = computeAvailableMs({ mode, currentDelayMs });
  const affordableWordCount = computeWordCountFromDurationMs({ durationMs: availableMs });
  if (affordableWordCount < range.minWordCount) {
    return { minWordCount: range.minWordCount, maxWordCount: range.maxWordCount, isDroppable: true };
  }
  return {
    minWordCount: range.minWordCount,
    maxWordCount: Math.min(range.maxWordCount, affordableWordCount),
    isDroppable: false,
  };
}

export function isDwellSatisfied({ dwellMs }) {
  return dwellMs >= DWELL_MS;
}

export function canSwitchMode({ fromMode, toMode }) {
  const fromPolicy = getModePolicy({ mode: fromMode });
  const toPolicy = getModePolicy({ mode: toMode });
  if (!fromPolicy || !toPolicy) return false;
  if (fromMode === toMode) return true;

  if (!IS_DELAY_BUFFER_ENABLED) return true;
  return fromPolicy.isSwitchableFrom;
}

export function getCatchupRateRange({ mode }) {
  const policy = getModePolicy({ mode });
  if (!policy || policy.isMixed) return { rateMin: 1.0, rateMax: 1.0 };
  return { rateMin: policy.rateMin, rateMax: policy.rateMax };
}
