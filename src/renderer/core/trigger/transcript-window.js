import {
  CONTEXT_TOKEN_BUDGET, CONTEXT_KEEP_MAP, estimateTokenCount, fitTextListToTokenBudget,
} from '../mode/context-budget.js';

const DEFAULT_MAX_ENTRY = 200;

export class TranscriptWindow {
  constructor({ maxEntry = DEFAULT_MAX_ENTRY } = {}) {
    this.maxEntry = maxEntry;
    this.entryList = [];
  }

  push({ text, ts }) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    this.entryList.push({ text: trimmed, ts });
    while (this.entryList.length > this.maxEntry) this.entryList.shift();
  }

  getBefore({ nowTs, windowMs, anchorTs = null, maxTokenCount = CONTEXT_TOKEN_BUDGET }) {
    return this.getBeforeDetail({ nowTs, windowMs, anchorTs, maxTokenCount }).text;
  }

  getBeforeDetail({ nowTs, windowMs, anchorTs = null, maxTokenCount = CONTEXT_TOKEN_BUDGET }) {
    const inWindowList = this.entryList
      .filter((entry) => entry.ts <= nowTs && nowTs - entry.ts < windowMs)
      .filter((entry) => !Number.isFinite(anchorTs) || entry.ts >= anchorTs)
      .map((entry) => entry.text);
    const fitted = fitTextListToTokenBudget({
      textList: inWindowList, maxTokenCount, keep: CONTEXT_KEEP_MAP.newest,
    });
    return {
      text: fitted.textList.join(' '),
      tokenCount: fitted.tokenCount,
      droppedCount: fitted.droppedCount,
    };
  }

  getAfter({ fromTs, windowMs = Infinity, maxTokenCount = CONTEXT_TOKEN_BUDGET }) {
    const inWindowList = this.entryList
      .filter((entry) => entry.ts > fromTs && entry.ts - fromTs <= windowMs)
      .map((entry) => entry.text);
    return fitTextListToTokenBudget({
      textList: inWindowList, maxTokenCount, keep: CONTEXT_KEEP_MAP.oldest,
    }).textList.join(' ');
  }

  getContext({ triggerTs, beforeMs, afterMs = Infinity, anchorTs = null,
    maxTokenCount = CONTEXT_TOKEN_BUDGET }) {
    const after = this.getAfter({ fromTs: triggerTs, windowMs: afterMs, maxTokenCount });
    const afterTokenCount = estimateTokenCount({ text: after });
    const before = this.getBeforeDetail({
      nowTs: triggerTs, windowMs: beforeMs, anchorTs,
      maxTokenCount: Math.max(0, maxTokenCount - afterTokenCount),
    });
    return {
      before: before.text,
      after,
      tokenCount: before.tokenCount + afterTokenCount,
      droppedCount: before.droppedCount,
    };
  }

  get size() {
    return this.entryList.length;
  }

  reset() {
    this.entryList = [];
  }
}
