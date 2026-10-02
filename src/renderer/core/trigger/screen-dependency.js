import { detectDeixis } from './deixis-detector.js';
import { CANDIDATE_SOURCE_MAP } from './deixis-candidate-scheduler.js';

export const SCREEN_DEPENDENCY_REASON_MAP = {
  speechTrigger: 'speech_trigger',
  unsupportedSource: 'unsupported_source',
};

// 발화 트리거는 라우터가 앞뒤 발화로 공백 여부를 가리므로 여기서는 통과시킨다.
export function judgeScreenDependency({ source, utterance = '' }) {
  if (source === CANDIDATE_SOURCE_MAP.speech) {
    return {
      isScreenDependent: true,
      reason: SCREEN_DEPENDENCY_REASON_MAP.speechTrigger,
      trigger: detectDeixis(utterance).trigger,
    };
  }
  return {
    isScreenDependent: false,
    reason: SCREEN_DEPENDENCY_REASON_MAP.unsupportedSource,
    trigger: null,
  };
}
