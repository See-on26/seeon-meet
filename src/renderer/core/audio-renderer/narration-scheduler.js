const DEFAULT_POLL_MS = 200;

export function isInsertDue({ captionCaptureMs, playbackTimeMs }) {
  return playbackTimeMs >= captionCaptureMs;
}

export class NarrationScheduler {
  constructor({ getPlaybackTimeMs, onDue, pollMs = DEFAULT_POLL_MS,
    setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = (handle) => clearInterval(handle) }) {
    this.getPlaybackTimeMs = getPlaybackTimeMs;
    this.onDue = onDue;
    this.pollMs = pollMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pendingList = [];
    this.timerHandle = null;
  }

  start() {
    if (this.timerHandle !== null) return;
    this.timerHandle = this.setTimer(() => this.tick(), this.pollMs);
  }

  schedule(item) {
    if (isInsertDue({
      captionCaptureMs: item.captionCaptureMs, playbackTimeMs: this.getPlaybackTimeMs(),
    })) {
      this.onDue(item);
      return;
    }
    this.pendingList.push(item);
    this.start();
  }

  tick() {
    if (!this.pendingList.length) return;
    const playbackTimeMs = this.getPlaybackTimeMs();
    const dueList = this.pendingList.filter(
      (item) => isInsertDue({ captionCaptureMs: item.captionCaptureMs, playbackTimeMs }));
    if (!dueList.length) return;
    this.pendingList = this.pendingList.filter((item) => !dueList.includes(item));
    dueList.sort((itemA, itemB) => itemA.captionCaptureMs - itemB.captionCaptureMs);
    for (const item of dueList) this.onDue(item);
  }

  get pendingCount() {
    return this.pendingList.length;
  }

  reset() {
    this.pendingList = [];
    if (this.timerHandle !== null) { this.clearTimer(this.timerHandle); this.timerHandle = null; }
  }
}
