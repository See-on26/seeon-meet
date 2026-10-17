import { NARRATION_CLASS_MAP } from '../constants.js';
import { isImmediateCaption } from './narration-entry.js';

// 재생을 기다리는 해설이 겹치면 이 순서로 먼저 들려준다. 사용자가 직접 물은 답(수동 AD)이 가장 앞이다.
// 페이지 전환과 화자 식별은 같은 순위(공동 2순위)이고, 함께 기다리면 SAME_PRIORITY_ORDER_MAP 순서로 들려준다.
export const NARRATION_PRIORITY_MAP = {
  [NARRATION_CLASS_MAP.userCommand]: 0,
  [NARRATION_CLASS_MAP.pageTransition]: 1,
  [NARRATION_CLASS_MAP.speakerIdentity]: 1,
  [NARRATION_CLASS_MAP.silenceBased]: 2,
  [NARRATION_CLASS_MAP.speechBased]: 3,
  [NARRATION_CLASS_MAP.deixis]: 4,
};

// 같은 순위 해설이 함께 기다리면 이 순서로 들려준다. 페이지 전환과 화자 식별이 겹치면 전환을 먼저 알리고 화자를 알린다.
export const SAME_PRIORITY_ORDER_MAP = {
  [NARRATION_CLASS_MAP.pageTransition]: 0,
  [NARRATION_CLASS_MAP.speakerIdentity]: 1,
};

// 재생 차례가 된 뒤 앞 해설이 끝나기를 이만큼 넘게 기다린 자동 해설은 발표가 이미 지나간 내용이라 버린다.
export const NARRATION_QUEUE_TTL_MS = 8000;

// 자동 해설이 재생 차례에 왔을 때 그 트리거(사건 시각)에서 이만큼 넘게 지났으면 버린다. 트리거에서 너무 멀어지면
// 무엇에 대한 해설인지 알 수 없고, 그사이 발표자가 이미 설명했을 수 있다(수동 AD 를 기다리는 보류 뒤에 특히 생긴다).
export const NARRATION_STALE_AFTER_TRIGGER_MS = 10000;

export const QUEUE_DROP_REASON_MAP = {
  expired: 'expired',
  stale: 'stale',
  slideChanged: 'slide_changed',
  featureOff: 'feature_off',
  ttsFailed: 'tts_failed',
  stopped: 'stopped',
  delayExceeded: 'delay_exceeded',
  dwellCancelled: 'dwell_cancelled',
  leaderCancelled: 'leader_cancelled',
  emitFailed: 'emit_failed',
};

export const QUEUE_DROP_LABEL_MAP = {
  [QUEUE_DROP_REASON_MAP.expired]: `재생 대기 ${NARRATION_QUEUE_TTL_MS / 1000}초 초과 — 버림`,
  [QUEUE_DROP_REASON_MAP.stale]: `트리거 뒤 ${NARRATION_STALE_AFTER_TRIGGER_MS / 1000}초 지남 — 지나간 내용이라 버림`,
  [QUEUE_DROP_REASON_MAP.slideChanged]: '다음 슬라이드 전환 고지가 앞서 — 이전 슬라이드 해설 버림',
  [QUEUE_DROP_REASON_MAP.featureOff]: '기능 꺼짐 — 대기 중이던 해설 버림',
  [QUEUE_DROP_REASON_MAP.ttsFailed]: 'TTS 합성 실패 — 소리 없이 건너뜀',
  [QUEUE_DROP_REASON_MAP.stopped]: '재생 멈춤(일시정지·모드 전환·정지) — 기다리던 해설 버림',
  [QUEUE_DROP_REASON_MAP.delayExceeded]: '누적 지연 상한 초과 — 해설 버림',
  [QUEUE_DROP_REASON_MAP.dwellCancelled]: '체류 미달 — 전환 고지 취소',
  [QUEUE_DROP_REASON_MAP.leaderCancelled]: '전환 고지 취소 — 딸린 사진 묘사도 버림',
  [QUEUE_DROP_REASON_MAP.emitFailed]: '해설 발행 실패 — 버림',
};

// 대기 줄이 재생할 해설을 고른 뒤에 소리를 만든다(Orchestrator → TTS). 기본은 해설에 이미 담긴 wav 를 쓴다.
export async function readEntryAudio(entry) {
  return entry?.wavArrayBuffer || null;
}

// main 은 분류가 빠진 캡션을 지시로 취급한다. 같은 순위로 맞춘다.
export function readNarrationPriority({ narrationClass }) {
  const priority = NARRATION_PRIORITY_MAP[narrationClass];
  return Number.isInteger(priority) ? priority : NARRATION_PRIORITY_MAP[NARRATION_CLASS_MAP.deixis];
}

function isPageTransition(entry) {
  return entry.narrationClass === NARRATION_CLASS_MAP.pageTransition;
}

// 전환 고지는 자동 해설 중 순위가 가장 높아(화자 식별과 같음) 오래 기다리지 않으므로 시간으로 버리지 않는다.
// 지난 슬라이드 고지는 다른 슬라이드의 더 늦은 고지가 있을 때 버려 쌓이지 않는다(takeNext).
function isExpirable(entry) {
  return !isImmediateCaption(entry) && !isPageTransition(entry);
}

function hasSlideLabel(entry) {
  return entry.slideLabel !== null && entry.slideLabel !== undefined && entry.slideLabel !== '';
}

function isOtherSlide({ entry, slideEntry }) {
  return hasSlideLabel(entry) && String(entry.slideLabel) !== String(slideEntry.slideLabel);
}

// 전환 고지는 체류 판정·생성 시간 때문에 늦게 들어온다. 앞뒤는 들어온 순서가 아니라 사건 시각(eventTimeMs)으로 가린다.
function isEarlierEvent({ entry, than }) {
  if (Number.isFinite(entry.eventTimeMs) && Number.isFinite(than.eventTimeMs)) {
    return entry.eventTimeMs < than.eventTimeMs;
  }
  return entry.seq < than.seq;
}

// 다른 슬라이드의 더 늦은 고지가 있으면 이 고지(딸린 사진 묘사 포함)는 이미 지나간 화면이다.
function isSupersededTransition({ entry, transitionList }) {
  return hasSlideLabel(entry) && transitionList.some((other) => hasSlideLabel(other)
    && isOtherSlide({ entry: other, slideEntry: entry }) && isEarlierEvent({ entry, than: other }));
}

function readSamePriorityOrder({ narrationClass }) {
  const order = SAME_PRIORITY_ORDER_MAP[narrationClass];
  return Number.isInteger(order) ? order : 0;
}

function compareEntry(left, right) {
  return readNarrationPriority(left) - readNarrationPriority(right)
    || readSamePriorityOrder(left) - readSamePriorityOrder(right)
    || left.seq - right.seq;
}

function pickFirst(entryList) {
  return entryList.reduce((best, entry) => (compareEntry(entry, best) < 0 ? entry : best));
}

export class NarrationQueue {
  // getPausedMs: 해설 때문에 회의가 멈춰 있던 누적 시간. 교차 모드는 그동안 재생 위치가 서 있어 기다린 시간에 넣지 않는다.
  // isEntryEnabled: 사용자가 끈 분류(C15)는 생성 중에 꺼졌거나 예약돼 있던 것도 재생하지 않는다.
  // getPlaybackTimeMs: 사용자가 지금 듣고 있는 영상 시각. 해설의 사건 시각(eventTimeMs)과 같은 축이다.
  constructor({ ttlMs = NARRATION_QUEUE_TTL_MS, now = () => performance.now(), getPausedMs = () => 0,
    isEntryEnabled = () => true, getPlaybackTimeMs = () => null } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.getPausedMs = getPausedMs;
    this.isEntryEnabled = isEntryEnabled;
    this.getPlaybackTimeMs = getPlaybackTimeMs;
    this.entryList = [];
    this.nextSeq = 0;
  }

  push(entry) {
    const dueAt = Number.isFinite(entry.dueAt) ? entry.dueAt : this.now();
    this.entryList.push({ ...entry, dueAt, pausedMsAtPush: this.getPausedMs(), seq: this.nextSeq });
    this.nextSeq += 1;
  }

  readWaitedMs({ entry, nowTs }) {
    return nowTs - entry.dueAt - (this.getPausedMs() - entry.pausedMsAtPush);
  }

  isStaleAfterTrigger({ entry, playbackMs }) {
    return Number.isFinite(playbackMs) && Number.isFinite(entry.eventTimeMs)
      && playbackMs - entry.eventTimeMs > NARRATION_STALE_AFTER_TRIGGER_MS;
  }

  takeNext() {
    const nowTs = this.now();
    const playbackMs = this.getPlaybackTimeMs();
    const droppedList = [];
    const drop = ({ entry, reason }) => droppedList.push({ entry, reason, waitedMs: this.readWaitedMs({ entry, nowTs }) });
    let aliveList = [];
    for (const entry of this.entryList) {
      if (!this.isEntryEnabled(entry)) {
        drop({ entry, reason: QUEUE_DROP_REASON_MAP.featureOff });
      } else if (isExpirable(entry) && this.isStaleAfterTrigger({ entry, playbackMs })) {
        drop({ entry, reason: QUEUE_DROP_REASON_MAP.stale });
      } else if (isExpirable(entry) && this.readWaitedMs({ entry, nowTs }) > this.ttlMs) {
        drop({ entry, reason: QUEUE_DROP_REASON_MAP.expired });
      } else {
        aliveList.push(entry);
      }
    }
    if (!aliveList.length) {
      this.entryList = [];
      return { entry: null, droppedList };
    }

    let next = pickFirst(aliveList);
    if (isPageTransition(next)) {
      const transitionList = aliveList.filter(isPageTransition);
      const supersededList = transitionList.filter((entry) => isSupersededTransition({ entry, transitionList }));
      for (const entry of supersededList) drop({ entry, reason: QUEUE_DROP_REASON_MAP.slideChanged });
      aliveList = aliveList.filter((entry) => !supersededList.includes(entry));
      // 남은 고지는 같은 슬라이드다. 고지 → 딸린 사진 묘사 순서는 들어온 순서로 지킨다.
      next = pickFirst(aliveList.filter(isPageTransition));
      // 새 슬라이드 고지보다 먼저 일어난 다른 슬라이드 해설은 고지 뒤에 들으면 새 슬라이드 설명처럼 들린다.
      if (hasSlideLabel(next)) {
        const keptList = [];
        for (const entry of aliveList) {
          const isStale = entry !== next && !isImmediateCaption(entry)
            && isOtherSlide({ entry, slideEntry: next }) && isEarlierEvent({ entry, than: next });
          if (isStale) drop({ entry, reason: QUEUE_DROP_REASON_MAP.slideChanged });
          else keptList.push(entry);
        }
        aliveList = keptList;
      }
    }
    this.entryList = aliveList.filter((entry) => entry !== next);
    return { entry: next, droppedList };
  }

  get size() {
    return this.entryList.length;
  }

  // 남은 해설을 모두 꺼내고 비운다. 호출부가 재생 못 한 해설로 알린다.
  drain() {
    const entryList = this.entryList;
    this.entryList = [];
    return entryList;
  }

  clear() {
    this.entryList = [];
  }
}
