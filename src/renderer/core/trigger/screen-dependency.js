import { detectDeixis, FEATURE1_KIND_LIST } from './deixis-detector.js';
import { CANDIDATE_SOURCE_MAP } from './deixis-candidate-scheduler.js';

const DEICTIC_KIND_SET = new Set(FEATURE1_KIND_LIST);

function detectExplicitDeixis({ text }) {
  const verdict = detectDeixis(text);
  const isDeictic = verdict.isDeixis && DEICTIC_KIND_SET.has(verdict.kind);
  return { isDeictic, trigger: isDeictic ? verdict.trigger : null };
}

export const SCREEN_DEPENDENCY_REASON_MAP = {
  speechTrigger: 'speech_trigger',
  deicticReference: 'deictic_reference',
  noAdjacentSpeech: 'no_adjacent_speech',
  spokenReference: 'spoken_reference',
};

export function judgeScreenDependency({ source, utterance = '', before = '', after = '' }) {
  if (source === CANDIDATE_SOURCE_MAP.speech) {
    return {
      isScreenDependent: true,
      reason: SCREEN_DEPENDENCY_REASON_MAP.speechTrigger,
      trigger: detectDeixis(utterance).trigger,
    };
  }

  const adjacentTextList = [utterance, after, before].map((text) => String(text || '').trim());
  if (!adjacentTextList.some(Boolean)) {
    return {
      isScreenDependent: false,
      reason: SCREEN_DEPENDENCY_REASON_MAP.noAdjacentSpeech,
      trigger: null,
    };
  }
  for (const text of adjacentTextList) {
    if (!text) continue;
    const { isDeictic, trigger } = detectExplicitDeixis({ text });
    if (isDeictic) {
      return {
        isScreenDependent: true,
        reason: SCREEN_DEPENDENCY_REASON_MAP.deicticReference,
        trigger,
      };
    }
  }

  return {
    isScreenDependent: false,
    reason: SCREEN_DEPENDENCY_REASON_MAP.spokenReference,
    trigger: null,
  };
}
