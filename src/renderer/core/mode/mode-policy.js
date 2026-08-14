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

export const CONTEXT_ANCHOR_MAP = {
  screenTransition: 'screen_transition',
  window: 'window',
};

export const LOOKAHEAD_MAX_MS = 2500;

const ASR_SEGMENT_REALTIME_MS = 2500;
const ASR_SEGMENT_DELAYED_MS = 3000;
const ASR_SEGMENT_LISTENING_MS = 10000;

export const PIPELINE_LATENCY_MARGIN_MS = 2000;

export const MODE_POLICY_MAP = {
  [MODE_MAP.listening]: {
    delayMs: 60000, maxNarrationMs: 12000, rateMin: 1.0, rateMax: 1.1,
    contextAnchor: CONTEXT_ANCHOR_MAP.screenTransition,
    beforeMs: CONTEXT_BEFORE_MS, afterMs: CONTEXT_AFTER_LISTENING_MS,
    asrSegmentMs: ASR_SEGMENT_LISTENING_MS,
    isSwitchableFrom: false, isSpeculative: false, isMixed: false,
  },
  [MODE_MAP.delayed]: {
    delayMs: 10000, maxNarrationMs: 6000, rateMin: 1.1, rateMax: 1.5,
    contextAnchor: CONTEXT_ANCHOR_MAP.screenTransition,
    beforeMs: CONTEXT_BEFORE_MS, afterMs: CONTEXT_AFTER_DELAYED_MS,
    asrSegmentMs: ASR_SEGMENT_DELAYED_MS,
    isSwitchableFrom: false, isSpeculative: false, isMixed: false,
  },
  [MODE_MAP.realtimeSic]: {
    delayMs: 0, maxNarrationMs: 3000, rateMin: 1.5, rateMax: 1.8,
    contextAnchor: CONTEXT_ANCHOR_MAP.window,
    beforeMs: CONTEXT_BEFORE_MS, afterMs: CONTEXT_AFTER_REALTIME_MS,
    asrSegmentMs: ASR_SEGMENT_REALTIME_MS,
    isSwitchableFrom: true, isSpeculative: true, isMixed: false,
  },
  [MODE_MAP.realtimeMix]: {
    delayMs: 0, maxNarrationMs: 6000, rateMin: 1.0, rateMax: 1.0,
    contextAnchor: CONTEXT_ANCHOR_MAP.window,
    beforeMs: CONTEXT_BEFORE_MS, afterMs: CONTEXT_AFTER_REALTIME_MS,
    asrSegmentMs: ASR_SEGMENT_REALTIME_MS,
    isSwitchableFrom: true, isSpeculative: true, isMixed: true,
  },
};

export const NARRATION_WORD_RANGE_MAP = {
  [NARRATION_TYPE_MAP.pageTransition]: {
    [PAGE_TRANSITION_KIND_MAP.slide]: { minWordCount: 6, maxWordCount: 9 },
    [PAGE_TRANSITION_KIND_MAP.document]: { minWordCount: 6, maxWordCount: 9 },
  },
  [NARRATION_TYPE_MAP.deixis]: {
    [DEIXIS_FORM_MAP.simple]: { minWordCount: 4, maxWordCount: 7 },
    [DEIXIS_FORM_MAP.complete]: { minWordCount: 6, maxWordCount: 10 },
  },
  [NARRATION_TYPE_MAP.interpretation]: {
    [INTERPRETATION_KIND_MAP.valueToMeaning]: { minWordCount: 6, maxWordCount: 12 },
    [INTERPRETATION_KIND_MAP.claimToValue]: { minWordCount: 6, maxWordCount: 12 },
  },
  [NARRATION_TYPE_MAP.visualDescription]: {
    [VISUAL_DESCRIPTION_KIND_MAP.reaction]: { minWordCount: 5, maxWordCount: 12 },
    [VISUAL_DESCRIPTION_KIND_MAP.scale]: { minWordCount: 4, maxWordCount: 8 },
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
