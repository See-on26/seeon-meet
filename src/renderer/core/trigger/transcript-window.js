import {
  CONTEXT_TOKEN_BUDGET, CONTEXT_KEEP_MAP, estimateTokenCount, fitTextListToTokenBudget,
} from '../mode/context-budget.js';
import { classifyUtteranceEnding, BOUNDARY_KIND_MAP } from './utterance-boundary-detector.js';

const DEFAULT_MAX_ENTRY = 200;
const DEFAULT_SENTENCE_LEAD_WINDOW_MS = 8000;
const DEFAULT_SENTENCE_LEAD_MAX_ENTRY = 3;

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

  // 가장 최근 조각(방금 들어온 트리거 조각) 앞에서 문장이 끝나지 않은 채 이어지는 조각을 순서대로 이어 붙인다.
  // 종결 어미를 만나거나, 시간 창을 벗어나거나, 최대 조각 수에 닿으면 멈춘다.
  getOpenSentenceLead({ nowTs, windowMs = DEFAULT_SENTENCE_LEAD_WINDOW_MS,
    maxEntryCount = DEFAULT_SENTENCE_LEAD_MAX_ENTRY }) {
    const pastList = this.entryList.filter((entry) => entry.ts <= nowTs);
    const leadList = [];
    for (let index = pastList.length - 2; index >= 0 && leadList.length < maxEntryCount; index -= 1) {
      const entry = pastList[index];
      if (nowTs - entry.ts > windowMs) break;
      if (classifyUtteranceEnding(entry.text) === BOUNDARY_KIND_MAP.complete) break;
      leadList.unshift(entry.text);
    }
    return leadList.join(' ');
  }

  get size() {
    return this.entryList.length;
  }

  reset() {
    this.entryList = [];
  }
}
