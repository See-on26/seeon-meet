// 라이브 회의 소리 크기(100ms 틱)로 실제로 조용했던 구간을 찾는다. ASR 끝 시각은 0.1~1초씩 틀려
// 그 시각에 해설을 넣으면 문장 한가운데서 회의가 멈춘다. 잰 무음 안에서 틈을 고르기 위해 구간을 모아 둔다.
// 시각은 모두 영상 시각(captureSource.videoTimeMs) 축이라 지연 재생 헤드와 바로 비교할 수 있다.
export const LEVEL_TICK_KIND_MAP = Object.freeze({
  speech: 'speech',
  silence: 'silence',
  between: 'between',
  unknown: 'unknown',
});

// 말소리 문턱은 ASR 세그먼터·무발화 판단과 같은 값이다. 둘 사이 값은 앞 상태를 이어 가 문턱 근처에서 흔들리지 않게 한다.
const DEFAULT_SPEECH_ON_LEVEL = 0.02;
const DEFAULT_SILENCE_OFF_LEVEL = 0.012;
// 낱말 안의 짧은 끊김(0.1초 안팎)을 무음으로 보지 않도록 무음 틱이 이만큼 이어져야 구간으로 친다.
const DEFAULT_CONFIRM_TICK_COUNT = 3;
// 틱이 이보다 벌어지면 그 사이는 잰 적이 없으므로 무음 구간을 이어 붙이지 않는다.
const DEFAULT_MAX_TICK_GAP_MS = 300;
// 품질 모드 지연(60초)보다 넉넉히 둔다.
const DEFAULT_RETAIN_MS = 90000;
// 레벨을 읽는 주기. 잰 무음 길이는 첫·마지막 무음 틱 사이라 실제보다 이만큼 짧다.
export const LEVEL_TICK_MS = 100;

export function classifyLevelTick({ level, speechOnLevel = DEFAULT_SPEECH_ON_LEVEL,
  silenceOffLevel = DEFAULT_SILENCE_OFF_LEVEL }) {
  if (!Number.isFinite(level)) return LEVEL_TICK_KIND_MAP.unknown;
  if (level > speechOnLevel) return LEVEL_TICK_KIND_MAP.speech;
  if (level < silenceOffLevel) return LEVEL_TICK_KIND_MAP.silence;
  return LEVEL_TICK_KIND_MAP.between;
}

export class SilenceSpanTracker {
  constructor({ speechOnLevel = DEFAULT_SPEECH_ON_LEVEL, silenceOffLevel = DEFAULT_SILENCE_OFF_LEVEL,
    confirmTickCount = DEFAULT_CONFIRM_TICK_COUNT, maxTickGapMs = DEFAULT_MAX_TICK_GAP_MS,
    retainMs = DEFAULT_RETAIN_MS } = {}) {
    this.speechOnLevel = speechOnLevel;
    this.silenceOffLevel = silenceOffLevel;
    this.confirmTickCount = confirmTickCount;
    this.maxTickGapMs = maxTickGapMs;
    this.retainMs = retainMs;
    this.reset();
  }

  reset() {
    this.closedSpanList = [];
    this.openSpanStartMs = null;
    this.lastSilenceTickMs = null;
    this.pendingStartMs = null;
    this.pendingTickCount = 0;
    this.closedCoverageList = [];
    this.coverageFromMs = null;
    this.lastTickMs = null;
  }

  // isBlind 인 틱은 판단하지 않는다(측정 없음과 같다). 해설 소리는 측정 신호에 섞이지 않아 기본으로는 쓰지 않는다.
  update({ videoTimeMs, level, isBlind = false }) {
    if (!Number.isFinite(videoTimeMs)) return;
    const kind = isBlind
      ? LEVEL_TICK_KIND_MAP.unknown
      : classifyLevelTick({ level, speechOnLevel: this.speechOnLevel, silenceOffLevel: this.silenceOffLevel });
    const isTickGap = this.lastTickMs !== null && videoTimeMs - this.lastTickMs > this.maxTickGapMs;
    if (kind === LEVEL_TICK_KIND_MAP.unknown || isTickGap) this.breakMeasurement();
    if (kind === LEVEL_TICK_KIND_MAP.unknown) return;

    if (this.coverageFromMs === null) this.coverageFromMs = videoTimeMs;
    if (kind === LEVEL_TICK_KIND_MAP.speech || (kind === LEVEL_TICK_KIND_MAP.between && this.openSpanStartMs === null)) {
      this.closeOpenSpan();
      this.clearPending();
    } else if (kind === LEVEL_TICK_KIND_MAP.silence) {
      this.lastSilenceTickMs = videoTimeMs;
      if (this.openSpanStartMs === null) this.advancePending(videoTimeMs);
    }
    this.lastTickMs = videoTimeMs;
    this.pruneBefore(videoTimeMs - this.retainMs);
  }

  // 무음 구간 목록. 진행 중인 구간은 마지막 무음 틱까지를 끝으로 보고 isOpen 으로 알린다.
  getSpanList() {
    const spanList = this.closedSpanList.map((span) => ({ ...span }));
    if (this.openSpanStartMs !== null) {
      spanList.push({ startMs: this.openSpanStartMs, endMs: this.lastSilenceTickMs, isOpen: true });
    }
    return spanList;
  }

  getCoverageList() {
    const coverageList = this.closedCoverageList.map((range) => ({ ...range }));
    if (this.coverageFromMs !== null) coverageList.push({ fromMs: this.coverageFromMs, toMs: this.lastTickMs });
    return coverageList;
  }

  isMeasuredAt(videoTimeMs) {
    return this.getCoverageList().some((range) => videoTimeMs >= range.fromMs && videoTimeMs <= range.toMs);
  }

  breakMeasurement() {
    this.closeOpenSpan();
    this.clearPending();
    if (this.coverageFromMs !== null) {
      this.closedCoverageList.push({ fromMs: this.coverageFromMs, toMs: this.lastTickMs });
      this.coverageFromMs = null;
    }
    this.lastTickMs = null;
  }

  advancePending(videoTimeMs) {
    if (this.pendingStartMs === null) this.pendingStartMs = videoTimeMs;
    this.pendingTickCount += 1;
    if (this.pendingTickCount < this.confirmTickCount) return;
    this.openSpanStartMs = this.pendingStartMs;
    this.clearPending();
  }

  // 말소리가 시작된 때는 마지막 무음 틱 뒤 어딘가라(사이 값 틱은 무음으로 치지 않는다),
  // 끝은 안전하게 마지막 무음 틱으로 둔다.
  closeOpenSpan() {
    if (this.openSpanStartMs === null) return;
    this.closedSpanList.push({ startMs: this.openSpanStartMs, endMs: this.lastSilenceTickMs, isOpen: false });
    this.openSpanStartMs = null;
  }

  clearPending() {
    this.pendingStartMs = null;
    this.pendingTickCount = 0;
  }

  pruneBefore(cutoffMs) {
    this.closedSpanList = this.closedSpanList.filter((span) => span.endMs >= cutoffMs);
    this.closedCoverageList = this.closedCoverageList.filter((range) => range.toMs >= cutoffMs);
  }
}
