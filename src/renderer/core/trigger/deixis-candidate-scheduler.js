import { classifyUtteranceEnding, BOUNDARY_KIND_MAP } from './utterance-boundary-detector.js';

// 지시 후보는 발화에서만 생긴다. 포인터 움직임은 대기 중인 발화 후보에 영역을 붙이는 데에만 쓴다.
export const CANDIDATE_SOURCE_MAP = {
  speech: 'speech',
};

const DEFAULT_LOOKAHEAD_MS = 2500;
const DEFAULT_COOLDOWN_MS = 4000;

function isSentenceComplete(text) {
  return classifyUtteranceEnding(text) === BOUNDARY_KIND_MAP.complete;
}

export class DeixisCandidateScheduler {
  constructor({ onDecide, lookaheadMs = DEFAULT_LOOKAHEAD_MS, cooldownMs = DEFAULT_COOLDOWN_MS,
    sentenceWaitMs = 0, getLastSpeechWallTs = null,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => clearTimeout(handle) }) {
    this.onDecide = onDecide;
    this.lookaheadMs = lookaheadMs;
    this.sentenceWaitMs = sentenceWaitMs;
    this.getLastSpeechWallTs = getLastSpeechWallTs;
    this.cooldownMs = cooldownMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = null;
    this.timerHandle = null;
    this.lastDecidedAt = -Infinity;
  }

  setLookaheadMs({ lookaheadMs }) {
    if (Number.isFinite(lookaheadMs) && lookaheadMs >= 0) this.lookaheadMs = lookaheadMs;
  }

  setSentenceWaitMs({ sentenceWaitMs }) {
    if (Number.isFinite(sentenceWaitMs) && sentenceWaitMs >= 0) this.sentenceWaitMs = sentenceWaitMs;
  }

  // leadText 는 트리거 조각 앞에서 문장이 안 끝난 채 이어지던 조각이다.
  // chunkEndWallTs 는 트리거 조각 녹음이 끝난 벽시계 시각이다.
  submit({ source, utterance = '', trigger = '', region = null, pointingOrderHint = '',
    captureTs, videoTimeMs, eventVideoTimeMs = null, leadText = '', chunkEndWallTs = null }) {
    if (this.pending) {
      this.absorb({ utterance, trigger, region, pointingOrderHint });
      return;
    }
    if (captureTs - this.lastDecidedAt < this.cooldownMs) return;
    this.pending = {
      source, utterance, triggerList: trigger ? [trigger] : [],
      region, pointingOrderHint, captureTs, videoTimeMs, eventVideoTimeMs,
      leadText, chunkEndWallTs, followList: [], isSentenceWaited: false,
    };
    this.timerHandle = this.setTimer(() => this.handleLookaheadEnd(), this.lookaheadMs);
  }

  // 대기 중에 들어온 전사 조각은 지시어가 없어도 뒤 조각으로 붙인다.
  // 문장 끝을 기다리는 중이면 문장 끝 조각이 오는 즉시 판정한다.
  // ASR 응답은 순서가 뒤바뀌어 올 수 있다. 트리거 조각보다 먼저 녹음된 조각(endTs ≤ chunkEndWallTs)은 뒤 조각이 아니다.
  // isDecided 는 이 조각으로 판정이 났다는 뜻이다. 호출부는 같은 조각으로 새 후보를 만들지 않는다.
  appendTranscript({ text, endTs = null }) {
    const trimmed = String(text || '').trim();
    if (!this.pending || !trimmed) return { isAppended: false, isDecided: false };
    const { chunkEndWallTs } = this.pending;
    if (Number.isFinite(endTs) && Number.isFinite(chunkEndWallTs) && endTs <= chunkEndWallTs) {
      return { isAppended: false, isDecided: false };
    }
    this.pending.followList.push(trimmed);
    if (this.pending.isSentenceWaited && isSentenceComplete(trimmed)) {
      this.clearTimer(this.timerHandle);
      this.fire();
      return { isAppended: true, isDecided: true };
    }
    return { isAppended: true, isDecided: false };
  }

  // 트리거 조각이 끝난 뒤 말소리가 한 번도 없었으면 아직 전사 중인 뒤 조각도 없다.
  // 알 수 없으면 이어진 것으로 본다.
  isSpeechContinued() {
    const { chunkEndWallTs } = this.pending;
    if (!this.getLastSpeechWallTs || !Number.isFinite(chunkEndWallTs)) return true;
    const lastSpeechWallTs = this.getLastSpeechWallTs();
    if (!Number.isFinite(lastSpeechWallTs) || lastSpeechWallTs <= 0) return true;
    return lastSpeechWallTs > chunkEndWallTs;
  }

  handleLookaheadEnd() {
    if (!this.pending) return;
    const { followList, utterance } = this.pending;
    const lastText = followList.length ? followList[followList.length - 1] : utterance;
    if (this.sentenceWaitMs <= 0 || isSentenceComplete(lastText) || !this.isSpeechContinued()) {
      this.fire();
      return;
    }
    this.pending.isSentenceWaited = true;
    this.timerHandle = this.setTimer(() => this.fire(), this.sentenceWaitMs);
  }

  absorb({ utterance, trigger, region, pointingOrderHint }) {
    if (!this.pending.utterance && utterance) this.pending.utterance = utterance;
    if (trigger && !this.pending.triggerList.includes(trigger)) this.pending.triggerList.push(trigger);
    if (!this.pending.region && region) this.pending.region = region;
    if (!this.pending.pointingOrderHint && pointingOrderHint) this.pending.pointingOrderHint = pointingOrderHint;
  }

  attachPointing({ region = null, pointingOrderHint = '' }) {
    if (!this.pending) return false;
    if (!this.pending.region && region) this.pending.region = region;
    if (!this.pending.pointingOrderHint && pointingOrderHint) this.pending.pointingOrderHint = pointingOrderHint;
    return true;
  }

  fire() {
    if (!this.pending) return;
    const { followList, leadText, utterance, ...rest } = this.pending;
    const followText = followList.join(' ');
    const decision = {
      ...rest,
      utterance: [leadText, utterance, followText].filter(Boolean).join(' '),
      triggerUtterance: utterance, leadText, followText,
    };
    this.pending = null;
    this.timerHandle = null;
    this.lastDecidedAt = decision.captureTs;
    this.onDecide?.(decision);
  }

  reset() {
    if (this.timerHandle !== null) { this.clearTimer(this.timerHandle); this.timerHandle = null; }
    this.pending = null;
    this.lastDecidedAt = -Infinity;
  }
}
