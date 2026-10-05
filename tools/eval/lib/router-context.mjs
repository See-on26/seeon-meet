import { TranscriptWindow } from '../../../src/renderer/core/trigger/transcript-window.js';
import { getModePolicy, computeWordBudget, resolveBeforeAnchorTs } from '../../../src/renderer/core/mode/mode-policy.js';
import {
  evaluateSilencePrecondition, SILENCE_TRIGGER_MS, SILENCE_TRANSCRIPT_WINDOW_MS,
} from '../../../src/renderer/core/trigger/silence-trigger.js';
import { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP } from '../../../src/renderer/core/constants.js';
import { PIECE_KIND_MAP } from './utterance-builder.mjs';

// 텍스트 평가에는 화면이 없다. 무발화 전제 조건의 "공유 화면 있음"을 채우는 값이다.
export const EVAL_SLIDE_LABEL = 'eval';

// 발화를 끝 시각으로 production TranscriptWindow 에 넣는다. 판정 대상 발화는 앞 맥락에 겹치지 않게 뺀다.
function createTranscriptWindow({ utteranceList, excludeIndex = null }) {
  const transcriptWindow = new TranscriptWindow({ maxEntry: utteranceList.length + 1 });
  for (const piece of utteranceList) {
    if (piece.kind !== PIECE_KIND_MAP.speech || piece.index === excludeIndex) continue;
    transcriptWindow.push({ text: piece.text, ts: piece.endMs });
  }
  return transcriptWindow;
}

export const CONTEXT_PRESET_MAP = {
  item: 'item',
  symmetric7: 'symmetric7',
  production: 'production',
};

// 평가 책임자가 정한 "맥락 창 7초"를 앞뒤 모두 7초로 읽은 값.
const SYMMETRIC_CONTEXT_MS = 7000;

// 텍스트 항목에는 화면 전환이 없으므로 항목 시작(0ms)을 전환 시각으로 본다.
const ITEM_START_TS = 0;

// ms 옵션은 undefined·null 이면 주지 않은 것으로 보고 프리셋 값을 쓴다.
// 그 밖에는 0 이상의 유한한 숫자여야 한다. 문자열·NaN 을 조용히 프리셋으로 바꾸면 다른 맥락 창으로 평가하게 된다.
function resolveMsOption({ value, fallback, optionName }) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    throw new Error(`${optionName} 는 0 이상의 숫자(ms)다 (지금: ${shown})`);
  }
  return value;
}

// item: 항목 전체(평가 셋은 트리거 문장 앞뒤 약 7초 분량으로 만든다). symmetric7: 앞뒤 7초.
// production: 모드 정책 그대로(균형이면 앞 60초를 전환 시각에 고정·뒤 7초). beforeMs·afterMs 를 주면 프리셋보다 앞선다.
// 길이 null 은 자르지 않는다는 뜻이다.
export function resolveContextWindow({ mode, preset = CONTEXT_PRESET_MAP.item, beforeMs = null, afterMs = null }) {
  const policy = getModePolicy({ mode });
  if (!policy) throw new Error(`알 수 없는 모드: ${mode}`);
  const presetWindowMap = {
    [CONTEXT_PRESET_MAP.item]: { beforeMs: null, afterMs: null, anchorTs: null },
    [CONTEXT_PRESET_MAP.symmetric7]: { beforeMs: SYMMETRIC_CONTEXT_MS, afterMs: SYMMETRIC_CONTEXT_MS, anchorTs: null },
    [CONTEXT_PRESET_MAP.production]: {
      beforeMs: policy.beforeMs, afterMs: policy.afterMs,
      anchorTs: resolveBeforeAnchorTs({ mode, screenTransitionTs: ITEM_START_TS }),
    },
  };
  const presetWindow = presetWindowMap[preset];
  if (!presetWindow) throw new Error(`--context 는 ${Object.values(CONTEXT_PRESET_MAP).join('|')} 중 하나다 (지금: ${preset})`);
  return {
    preset,
    beforeMs: resolveMsOption({ value: beforeMs, fallback: presetWindow.beforeMs, optionName: '--before-ms' }),
    afterMs: resolveMsOption({ value: afterMs, fallback: presetWindow.afterMs, optionName: '--after-ms' }),
    anchorTs: presetWindow.anchorTs,
  };
}

export function buildRouterInput({ utteranceList, index, contextWindow }) {
  const utterance = utteranceList[index];
  const { before, after } = createTranscriptWindow({ utteranceList, excludeIndex: index }).getContext({
    triggerTs: utterance.endMs,
    beforeMs: contextWindow.beforeMs ?? Infinity,
    afterMs: contextWindow.afterMs ?? Infinity,
    anchorTs: contextWindow.anchorTs,
  });
  return { utterance: utterance.text, before, after };
}

// production 무발화 트리거는 무음 5초가 되는 순간 직전 15초 전사로 판정한다. 그래서 늘 약 5초로 묻는다.
export function buildSilenceInput({ utteranceList, index, mode }) {
  const silence = utteranceList[index];
  const recentTranscript = createTranscriptWindow({ utteranceList }).getBefore({
    nowTs: silence.startMs + SILENCE_TRIGGER_MS, windowMs: SILENCE_TRANSCRIPT_WINDOW_MS,
  });
  const wordBudget = computeWordBudget({
    mode, narrationType: NARRATION_TYPE_MAP.visualDescription, subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction,
  });
  const precondition = evaluateSilencePrecondition({ slideLabel: EVAL_SLIDE_LABEL, recentTranscript, wordBudget });
  return { transcript: recentTranscript, silenceMs: SILENCE_TRIGGER_MS, precondition };
}
