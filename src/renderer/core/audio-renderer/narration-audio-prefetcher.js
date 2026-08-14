import { isImmediateCaption } from './narration-entry.js';
import { readNarrationPriority } from './narration-queue.js';

// 재생 차례가 가까운 자동 해설은 이 개수까지 미리 목소리를 만들어 둔다. 기다리는 동안 합성이 끝나 차례가 오면 바로 들린다.
// 그보다 뒤에 있는 해설은 앞 해설이 재생되거나 버려질 때 차례로 만든다 — 버려질 해설 대부분은 합성하지 않는다.
export const PREFETCH_AHEAD_COUNT = 2;

export function narrationEntryKey(entry) {
  return `${entry?.ts}|${entry?.text}`;
}

// Orchestrator 가 고른 해설만 TTS 로 보내되, 재생 차례가 가까운 것은 미리 합성해 지연을 숨긴다.
// 질문 답은 늘 바로 만든다(미리 만들기 개수에 세지 않는다).
export class NarrationAudioPrefetcher {
  constructor({ synthesize, aheadCount = PREFETCH_AHEAD_COUNT }) {
    this.synthesize = synthesize;
    this.aheadCount = aheadCount;
    this.waitingList = [];
    this.jobMap = new Map();
    this.nextSeq = 0;
  }

  // 해설 문장이 렌더러에 도착하면 등록한다. 질문 답은 바로, 자동 해설은 미리 만들기 자리가 있으면 바로 합성을 시작한다.
  register(entry) {
    const key = narrationEntryKey(entry);
    if (this.jobMap.has(key) || this.waitingList.some((waiting) => waiting.key === key)) return;
    if (isImmediateCaption(entry)) {
      this._start({ key, entry, isAhead: false });
      return;
    }
    this.waitingList.push({ key, entry, seq: this.nextSeq });
    this.nextSeq += 1;
    this._fill();
  }

  // 재생기가 재생할 차례로 고른 해설의 소리. 미리 만든 것이 있으면 그것을, 없으면 지금 만든다.
  take(entry) {
    const key = narrationEntryKey(entry);
    const job = this.jobMap.get(key);
    this._remove(key);
    this._fill();
    return job ? job.promise : this._run(entry);
  }

  // 재생되지 못하고 버려진 해설. 미리 만들던 자리를 다음 해설에 넘긴다.
  discard(entry) {
    this._remove(narrationEntryKey(entry));
    this._fill();
  }

  get aheadKeyList() {
    return [...this.jobMap.entries()].filter(([, job]) => job.isAhead).map(([key]) => key);
  }

  reset() {
    this.waitingList = [];
    this.jobMap.clear();
  }

  _remove(key) {
    this.jobMap.delete(key);
    this.waitingList = this.waitingList.filter((waiting) => waiting.key !== key);
  }

  // 순위가 높은 해설(같으면 먼저 온 해설)부터 자리를 채운다.
  _fill() {
    let aheadCount = this.aheadKeyList.length;
    while (aheadCount < this.aheadCount && this.waitingList.length) {
      const next = this.waitingList.reduce((best, waiting) => (
        readNarrationPriority(waiting.entry) - readNarrationPriority(best.entry) || waiting.seq - best.seq) < 0 ? waiting : best);
      this.waitingList = this.waitingList.filter((waiting) => waiting !== next);
      this._start({ key: next.key, entry: next.entry, isAhead: true });
      aheadCount += 1;
    }
  }

  _start({ key, entry, isAhead }) {
    this.jobMap.set(key, { isAhead, promise: this._run(entry) });
  }

  _run(entry) {
    return Promise.resolve().then(() => this.synthesize(entry)).catch(() => null);
  }
}
