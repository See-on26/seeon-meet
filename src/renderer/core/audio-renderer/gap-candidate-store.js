const DEFAULT_MAX_ENTRY = 300;
const DEFAULT_LIMIT = 10;

export class GapCandidateStore {
  constructor({ maxEntry = DEFAULT_MAX_ENTRY } = {}) {
    this.maxEntry = maxEntry;
    this.entryList = [];
  }

  add({ videoTimeMs, kind, silenceMs = 0, text = '' }) {
    if (!Number.isFinite(videoTimeMs) || videoTimeMs < 0) return;
    this.entryList.push({ videoTimeMs, kind, silenceMs, text: String(text || '').trim() });
    this.entryList.sort((left, right) => left.videoTimeMs - right.videoTimeMs);
    while (this.entryList.length > this.maxEntry) this.entryList.shift();
  }

  getCandidateList({ triggerVideoTimeMs, fromVideoTimeMs, toVideoTimeMs, limit = DEFAULT_LIMIT }) {
    const inRangeList = this.entryList
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.videoTimeMs > fromVideoTimeMs && entry.videoTimeMs <= toVideoTimeMs);

    const nearestList = [...inRangeList]
      .sort((left, right) => Math.abs(left.entry.videoTimeMs - triggerVideoTimeMs)
        - Math.abs(right.entry.videoTimeMs - triggerVideoTimeMs))
      .slice(0, limit)
      .sort((left, right) => left.entry.videoTimeMs - right.entry.videoTimeMs);
    return nearestList.map(({ entry, index }) => ({
      videoTimeMs: entry.videoTimeMs,
      offsetMs: Math.round(entry.videoTimeMs - triggerVideoTimeMs),
      kind: entry.kind,
      silenceMs: entry.silenceMs,
      beforeText: entry.text,
      afterText: this.entryList[index + 1]?.text || '',
    }));
  }

  get size() {
    return this.entryList.length;
  }

  reset() {
    this.entryList = [];
  }
}
