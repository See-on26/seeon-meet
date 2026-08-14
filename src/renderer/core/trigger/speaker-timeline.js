// 회의 스크립트의 화자 구분용. Meet 화면의 말하는 사람 표시를 벽시계 시각과 함께 모아 두고,
// 전사 조각마다 그 구간에 가장 오래 말한 사람을 고른다. 조각이 끝난 순간의 화자만 보면 조각 앞쪽 화자를 놓친다.
// 화자 식별 기능(C15)을 끄면 호출부가 이름 없음(null)만 기록해, 그 구간 발화에는 화자를 붙이지 않는다.
export const SPEAKER_TIMELINE_RETENTION_MS = 120000;

export class SpeakerTimeline {
  constructor({ retentionMs = SPEAKER_TIMELINE_RETENTION_MS } = {}) {
    this.retentionMs = retentionMs;
    this.sampleList = [];
  }

  // name 이 null 이면 그때는 한 사람으로 정할 수 없었다(아무도 안 말함·동시 발화·본인 발화).
  record({ wallTs, name }) {
    if (!Number.isFinite(wallTs)) return;
    const last = this.sampleList[this.sampleList.length - 1];
    if (last && wallTs < last.wallTs) return;
    if (last && last.name === (name || null)) return;
    this.sampleList.push({ wallTs, name: name || null });
    const cutoffTs = wallTs - this.retentionMs;
    while (this.sampleList.length > 1 && this.sampleList[1].wallTs <= cutoffTs) this.sampleList.shift();
  }

  // 각 표본은 다음 표본까지 이어진 것으로 본다. 구간과 겹친 시간이 가장 긴 이름을 고르고, 아무도 없으면 null.
  resolveDominant({ startTs, endTs }) {
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs < startTs) return null;
    const durationByNameMap = new Map();
    for (let index = 0; index < this.sampleList.length; index += 1) {
      const { wallTs, name } = this.sampleList[index];
      if (!name) continue;
      const nextTs = index + 1 < this.sampleList.length ? this.sampleList[index + 1].wallTs : Infinity;
      const overlapMs = Math.min(nextTs, endTs) - Math.max(wallTs, startTs);
      if (overlapMs > 0) durationByNameMap.set(name, (durationByNameMap.get(name) || 0) + overlapMs);
    }
    let bestName = null;
    let bestMs = 0;
    for (const [name, durationMs] of durationByNameMap) {
      if (durationMs > bestMs) { bestName = name; bestMs = durationMs; }
    }
    return bestName;
  }

  reset() {
    this.sampleList = [];
  }
}
