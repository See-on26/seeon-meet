import { classifyUtteranceEnding, BOUNDARY_KIND_MAP } from './utterance-boundary-detector.js';
import { describeTriggerCandidateList } from './deixis-detector.js';

// 지시 후보는 발화에서만 생긴다. 포인터 움직임은 대기 중인 발화 후보에 영역을 붙이는 데에만 쓴다.
export const CANDIDATE_SOURCE_MAP = {
  speech: 'speech',
};

// submit 결과. started 는 새 후보로 look-ahead 를 시작했다, absorbed 는 look-ahead 중인 후보에 합쳤다,
// merged 는 판정은 났지만 아직 판단 LLM 으로 보내기 전(보류 중)인 결정에 합쳤다는 뜻이다.
export const SUBMIT_RESULT_MAP = {
  started: 'started',
  absorbed: 'absorbed',
  merged: 'merged',
};

const DEFAULT_LOOKAHEAD_MS = 2500;

function isSentenceComplete(text) {
  return classifyUtteranceEnding(text) === BOUNDARY_KIND_MAP.complete;
}

// ASR 응답은 순서가 뒤바뀌어 올 수 있다. 트리거 조각보다 먼저 녹음된 조각(endTs ≤ chunkEndWallTs)은 뒤 조각이 아니다.
function isBeforeTriggerChunk({ endTs, chunkEndWallTs }) {
  return Number.isFinite(endTs) && Number.isFinite(chunkEndWallTs) && endTs <= chunkEndWallTs;
}

function buildDecision({ decisionId, source, utterance, triggerList, candidateList, region, pointingOrderHint,
  captureTs, videoTimeMs, eventVideoTimeMs, leadText, chunkEndWallTs, followList, isSentenceWaited, mergedChunkCount }) {
  const followText = followList.join(' ');
  return {
    decisionId, source, triggerList: [...triggerList], candidateList: [...candidateList],
    region, pointingOrderHint, captureTs, videoTimeMs, eventVideoTimeMs, chunkEndWallTs, isSentenceWaited,
    utterance: [leadText, utterance, followText].filter(Boolean).join(' '),
    triggerUtterance: utterance, leadText, followText, mergedChunkCount,
  };
}

// 후보 하나는 look-ahead → 판정 → 보류 → 확정 순서로 간다. look-ahead 와 보류 앞부분에 들어온 조각과 후보는 그 결정에 합치고,
// 그 뒤에 들어온 후보는 버리지 않고 새 후보로 따로 판단한다. 해설이 몰리는 것은 main 의 차단 규칙(같은 축 12/18초)이 막는다.
// 보류(holdMs)는 균형·품질 모드가 뒤 맥락을 모으려고 판단 LLM 호출을 미루는 시간이다. 보류 중에도 look-ahead 길이까지만 합친다.
// 품질 모드처럼 보류가 길면(27.5초) 한 결정에 후보가 몰려 판단 응답이 잘리고 해설도 하나밖에 못 내기 때문이다.
// 그래서 합칠 수 있는 결정(held)은 하나지만, 보류 중인 결정(holdingSet)은 여럿일 수 있다.
export class DeixisCandidateScheduler {
  constructor({ onDecide, lookaheadMs = DEFAULT_LOOKAHEAD_MS, sentenceWaitMs = 0, holdMs = 0,
    getLastSpeechWallTs = null,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => clearTimeout(handle) }) {
    this.onDecide = onDecide;
    this.lookaheadMs = lookaheadMs;
    this.sentenceWaitMs = sentenceWaitMs;
    this.holdMs = holdMs;
    this.getLastSpeechWallTs = getLastSpeechWallTs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = null;
    this.timerHandle = null;
    this.held = null;
    this.holdingSet = new Set();
    this.decisionSeq = 0;
  }

  setLookaheadMs({ lookaheadMs }) {
    if (Number.isFinite(lookaheadMs) && lookaheadMs >= 0) this.lookaheadMs = lookaheadMs;
  }

  setSentenceWaitMs({ sentenceWaitMs }) {
    if (Number.isFinite(sentenceWaitMs) && sentenceWaitMs >= 0) this.sentenceWaitMs = sentenceWaitMs;
  }

  setHoldMs({ holdMs }) {
    if (Number.isFinite(holdMs) && holdMs >= 0) this.holdMs = holdMs;
  }

  // leadText 는 트리거 조각 앞에서 문장이 안 끝난 채 이어지던 조각이다.
  // chunkEndWallTs 는 트리거 조각 녹음이 끝난 벽시계 시각이다.
  // candidateList 는 main 트리거가 뽑은 후보 구다. 대기·보류 중에 들어온 조각의 후보도 모아 한 번에 판단을 받는다.
  submit({ source, utterance = '', trigger = '', candidateList = [], region = null, pointingOrderHint = '',
    captureTs, videoTimeMs, eventVideoTimeMs = null, leadText = '', chunkEndWallTs = null }) {
    if (this.pending) {
      this.absorb({ utterance, trigger, candidateList, region, pointingOrderHint });
      return SUBMIT_RESULT_MAP.absorbed;
    }
    if (this.held) {
      this.mergeHeld({ trigger, candidateList });
      return SUBMIT_RESULT_MAP.merged;
    }
    this.pending = {
      source, utterance, triggerList: trigger ? [trigger] : [], candidateList: [...candidateList],
      region, pointingOrderHint, captureTs, videoTimeMs, eventVideoTimeMs,
      leadText, chunkEndWallTs, followList: [], isSentenceWaited: false,
    };
    this.timerHandle = this.setTimer(() => this.handleLookaheadEnd(), this.lookaheadMs);
    return SUBMIT_RESULT_MAP.started;
  }

  // look-ahead 중에 들어온 전사 조각은 지시어가 없어도 뒤 조각으로 붙이고, 조각의 후보도 함께 붙인다.
  // 문장 끝을 기다리는 중이면 문장 끝 조각이 오는 즉시 판정한다. 그 조각의 후보도 이미 붙었으므로 함께 판단을 받는다.
  // 보류 중 합칠 수 있는 동안 들어온 조각은 모아 두었다가 후보가 있는 조각이 오면 그 조각까지 뒤 조각으로 합친다.
  // 후보가 끝내 안 오면 모아 둔 조각은 발화에 넣지 않는다(뒤 맥락으로는 들어간다).
  // isAppended 는 이 조각이 결정의 발화에 들어갔다는 뜻이다.
  // isDecided 는 이 조각으로 판정이 났다는 뜻이다. 호출부는 같은 조각으로 새 후보를 만들지 않는다.
  appendTranscript({ text, endTs = null, candidateList = [] }) {
    const trimmed = String(text || '').trim();
    const target = this.pending || this.held;
    if (!target || !trimmed || isBeforeTriggerChunk({ endTs, chunkEndWallTs: target.chunkEndWallTs })) {
      return { isAppended: false, isDecided: false };
    }
    const validList = (candidateList || []).filter((candidate) => candidate?.phrase);
    const trigger = describeTriggerCandidateList(validList);
    if (this.held) {
      this.held.tailList.push(trimmed);
      if (!validList.length) return { isAppended: false, isDecided: false };
      this.mergeHeld({ trigger, candidateList: validList });
      return { isAppended: true, isDecided: false };
    }
    this.pending.followList.push(trimmed);
    this.absorbCandidate(this.pending, { trigger, candidateList: validList });
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

  // 같은 후보 구는 한 번만 판단을 받는다.
  absorbCandidate(target, { trigger, candidateList = [] }) {
    if (trigger && !target.triggerList.includes(trigger)) target.triggerList.push(trigger);
    for (const candidate of candidateList) {
      if (!candidate?.phrase) continue;
      const isKnown = target.candidateList.some((known) => known.type === candidate.type && known.phrase === candidate.phrase);
      if (!isKnown) target.candidateList.push(candidate);
    }
  }

  absorb({ utterance, trigger, candidateList = [], region, pointingOrderHint }) {
    if (!this.pending.utterance && utterance) this.pending.utterance = utterance;
    this.absorbCandidate(this.pending, { trigger, candidateList });
    if (!this.pending.region && region) this.pending.region = region;
    if (!this.pending.pointingOrderHint && pointingOrderHint) this.pending.pointingOrderHint = pointingOrderHint;
  }

  // 보류 중인 결정은 화면을 이미 찍었으므로 영역은 붙이지 않고, 모아 둔 조각과 후보만 합친다.
  mergeHeld({ trigger, candidateList = [] }) {
    const { held } = this;
    held.mergedChunkCount += held.tailList.length;
    held.followList.push(...held.tailList);
    held.tailList = [];
    this.absorbCandidate(held, { trigger, candidateList });
  }

  attachPointing({ region = null, pointingOrderHint = '' }) {
    if (!this.pending) return false;
    if (!this.pending.region && region) this.pending.region = region;
    if (!this.pending.pointingOrderHint && pointingOrderHint) this.pending.pointingOrderHint = pointingOrderHint;
    return true;
  }

  // 판정이 나면 결정을 바로 넘긴다(호출부는 이때 화면을 찍는다). 판단 LLM 에 보낼 결정은 whenSealed 로 받는다.
  // 보류가 있으면 보류가 끝날 때 그동안 합친 조각·후보까지 담아 오고, reset 으로 버려지면 null 이 온다.
  fire() {
    if (!this.pending) return;
    this.decisionSeq += 1;
    const entry = {
      ...this.pending, decisionId: this.decisionSeq, tailList: [], mergedChunkCount: 0,
      resolveSealed: null, sealTimerHandle: null, mergeTimerHandle: null,
    };
    this.pending = null;
    this.timerHandle = null;
    const whenSealed = new Promise((resolve) => { entry.resolveSealed = resolve; });
    const decision = { ...buildDecision(entry), whenSealed };
    if (this.holdMs > 0) {
      this.holdingSet.add(entry);
      this.held = entry;
      entry.sealTimerHandle = this.setTimer(() => this.seal(entry), this.holdMs);
      const mergeWindowMs = Math.min(this.holdMs, this.lookaheadMs);
      if (mergeWindowMs < this.holdMs) {
        entry.mergeTimerHandle = this.setTimer(() => this.closeMerge(entry), mergeWindowMs);
      }
    } else {
      entry.resolveSealed(buildDecision(entry));
    }
    this.onDecide?.(decision);
  }

  // 합치는 시간이 끝나도 결정은 보류가 끝날 때까지 기다린다. 그동안 모아 둔 후보 없는 조각은 뒤 맥락으로만 쓰인다.
  closeMerge(entry) {
    entry.mergeTimerHandle = null;
    if (this.held === entry) this.held = null;
  }

  seal(entry) {
    if (!this.holdingSet.has(entry)) return;
    this.holdingSet.delete(entry);
    if (this.held === entry) this.held = null;
    if (entry.mergeTimerHandle !== null) { this.clearTimer(entry.mergeTimerHandle); entry.mergeTimerHandle = null; }
    entry.sealTimerHandle = null;
    entry.resolveSealed(buildDecision(entry));
  }

  reset() {
    if (this.timerHandle !== null) { this.clearTimer(this.timerHandle); this.timerHandle = null; }
    const holdingList = [...this.holdingSet];
    this.pending = null;
    this.held = null;
    this.holdingSet.clear();
    for (const entry of holdingList) {
      if (entry.sealTimerHandle !== null) this.clearTimer(entry.sealTimerHandle);
      if (entry.mergeTimerHandle !== null) this.clearTimer(entry.mergeTimerHandle);
      entry.resolveSealed(null);
    }
  }
}
