export const BOUNDARY_KIND_MAP = {
  complete: 'complete',
  pause: 'pause',
};

const SENTENCE_FINAL_PATTERN_LIST = [
  /[.?!]$/,
  /(습니다|ㅂ니다|입니다|랍니다|답니다|납니다)$/,
  /(이에요|예요|에요|세요|해요|어요|아요|여요|게요)$/,
  /(는군요|군요|는데요|네요|지요|죠|나요|까요|을까요|ㄹ까요)$/,
  /(다|요|까|죠|네)$/,
];

const CONNECTIVE_TRAILING_PATTERN_LIST = [
  /데$/,
  /(다가|다가요)$/,
  /(그래서|그리고|그러면|근데|그러니까|그래가지고)$/,
  /(고|며|면서|면|지만|어서|아서|니까|는|라서|든지)$/,
  /(…|\.\.\.|~|,)$/,
];

const HESITATION_WORD_LIST = ['잠시만요', '잠깐만요', '잠시만', '잠깐만', '저기요', '음', '어', '그'];

const DEFAULT_COMPLETE_SILENCE_MS = 250;
const DEFAULT_PAUSE_SILENCE_MS = 550;

const DEFAULT_LONG_SILENCE_MS = 700;

function extractLastToken(text) {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const tokenList = trimmed.split(/\s+/);
  return tokenList[tokenList.length - 1];
}

export function classifyUtteranceEnding(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const lastToken = extractLastToken(trimmed);

  const bareWord = lastToken.replace(/[.…~,!?]+$/, '');
  if (HESITATION_WORD_LIST.includes(bareWord)) return BOUNDARY_KIND_MAP.pause;

  if (CONNECTIVE_TRAILING_PATTERN_LIST.some((pattern) => pattern.test(lastToken))) {
    return BOUNDARY_KIND_MAP.pause;
  }
  if (SENTENCE_FINAL_PATTERN_LIST.some((pattern) => pattern.test(lastToken))) {
    return BOUNDARY_KIND_MAP.complete;
  }
  return null;
}

export function resolveBoundaryKind({ text, silenceMs,
  completeSilenceMs = DEFAULT_COMPLETE_SILENCE_MS,
  pauseSilenceMs = DEFAULT_PAUSE_SILENCE_MS,
  longSilenceMs = DEFAULT_LONG_SILENCE_MS }) {
  const ending = classifyUtteranceEnding(text);
  if (ending === BOUNDARY_KIND_MAP.complete && silenceMs >= completeSilenceMs) {
    return BOUNDARY_KIND_MAP.complete;
  }
  if (ending === BOUNDARY_KIND_MAP.pause && silenceMs >= pauseSilenceMs) {
    return BOUNDARY_KIND_MAP.pause;
  }

  if (silenceMs >= longSilenceMs) return BOUNDARY_KIND_MAP.pause;
  return null;
}

export function buildSegmentBoundaryList({ segmentList, chunkDurationMs,
  completeSilenceMs = DEFAULT_COMPLETE_SILENCE_MS,
  pauseSilenceMs = DEFAULT_PAUSE_SILENCE_MS,
  longSilenceMs = DEFAULT_LONG_SILENCE_MS }) {
  if (!Array.isArray(segmentList)) return [];
  const boundaryList = [];
  segmentList.forEach((segment, index) => {
    const endMs = Math.round(segment.endSec * 1000);
    const nextStartMs = index + 1 < segmentList.length
      ? Math.round(segmentList[index + 1].startSec * 1000) : chunkDurationMs;
    const silenceMs = Math.max(0, nextStartMs - endMs);
    const text = String(segment.text || '').trim();
    if (!text) return;
    const kind = resolveBoundaryKind({
      text, silenceMs, completeSilenceMs, pauseSilenceMs, longSilenceMs,
    });
    if (kind) boundaryList.push({ offsetMs: endMs, silenceMs, kind, text });
  });
  return boundaryList;
}

export class UtteranceBoundaryDetector {
  constructor({ onBoundary, completeSilenceMs = DEFAULT_COMPLETE_SILENCE_MS,
    pauseSilenceMs = DEFAULT_PAUSE_SILENCE_MS }) {
    this.onBoundary = onBoundary;
    this.completeSilenceMs = completeSilenceMs;
    this.pauseSilenceMs = pauseSilenceMs;
    this.lastEmittedText = '';
    this.lastEmittedTs = 0;
  }

  reset() {
    this.lastEmittedText = '';
    this.lastEmittedTs = 0;
  }

  handleTranscript({ text, captureEndTs, silenceMsAfter = 0 }) {
    const kind = classifyUtteranceEnding(text);
    if (!kind) return null;

    const requiredSilenceMs = kind === BOUNDARY_KIND_MAP.complete
      ? this.completeSilenceMs : this.pauseSilenceMs;
    if (silenceMsAfter < requiredSilenceMs) return null;

    const trimmed = text.trim();
    if (trimmed === this.lastEmittedText && captureEndTs === this.lastEmittedTs) return null;

    this.lastEmittedText = trimmed;
    this.lastEmittedTs = captureEndTs;
    const boundaryEvent = { kind, captureTs: captureEndTs, text: trimmed, silenceMsAfter };
    this.onBoundary?.(boundaryEvent);
    return boundaryEvent;
  }
}
