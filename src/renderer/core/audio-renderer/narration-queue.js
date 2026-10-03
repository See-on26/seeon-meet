import { NARRATION_CLASS_MAP } from '../constants.js';
import { isImmediateCaption } from './narration-entry.js';

// 재생을 기다리는 해설이 겹치면 이 순서로 먼저 들려준다. 사용자가 직접 물은 답이 가장 앞이다.
export const NARRATION_PRIORITY_MAP = {
  [NARRATION_CLASS_MAP.userCommand]: 0,
  [NARRATION_CLASS_MAP.pageTransition]: 1,
  [NARRATION_CLASS_MAP.deixis]: 2,
  [NARRATION_CLASS_MAP.speechBased]: 3,
  [NARRATION_CLASS_MAP.silenceBased]: 4,
  [NARRATION_CLASS_MAP.speakerIdentity]: 5,
};

// 재생 차례가 된 뒤 앞 해설이 끝나기를 이만큼 넘게 기다린 자동 해설은 발표가 이미 지나간 내용이라 버린다.
export const NARRATION_QUEUE_TTL_MS = 8000;

export const QUEUE_DROP_REASON_MAP = {
  expired: 'expired',
  slideChanged: 'slide_changed',
  interrupted: 'interrupted',
};

export const QUEUE_DROP_LABEL_MAP = {
  [QUEUE_DROP_REASON_MAP.expired]: `재생 대기 ${NARRATION_QUEUE_TTL_MS / 1000}초 초과 — 버림`,
  [QUEUE_DROP_REASON_MAP.slideChanged]: '다음 슬라이드 전환 고지가 앞서 — 이전 슬라이드 해설 버림',
  [QUEUE_DROP_REASON_MAP.interrupted]: '질문 답이 재생 중인 해설을 끊음',
};

// main 은 분류가 빠진 캡션을 지시로 취급한다. 같은 순위로 맞춘다.
export function readNarrationPriority({ narrationClass }) {
  const priority = NARRATION_PRIORITY_MAP[narrationClass];
  return Number.isInteger(priority) ? priority : NARRATION_PRIORITY_MAP[NARRATION_CLASS_MAP.deixis];
}

// 질문 답만 재생 중인 자동 해설을 끊는다. 자동 해설끼리는 끊지 않고 다음 차례만 앞당긴다.
export function shouldInterrupt({ currentEntry, incomingEntry }) {
  return Boolean(currentEntry) && isImmediateCaption(incomingEntry) && !isImmediateCaption(currentEntry);
}

function isPageTransition(entry) {
  return entry.narrationClass === NARRATION_CLASS_MAP.pageTransition;
}

// 전환 고지는 순위가 가장 높아 앞 해설 하나만 기다리므로 시간으로 버리지 않는다.
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

function compareEntry(left, right) {
  return readNarrationPriority(left) - readNarrationPriority(right) || left.seq - right.seq;
}

function pickFirst(entryList) {
  return entryList.reduce((best, entry) => (compareEntry(entry, best) < 0 ? entry : best));
}

export class NarrationQueue {
  // getPausedMs: 해설 때문에 회의가 멈춰 있던 누적 시간. 교차 모드는 그동안 재생 위치가 서 있어 기다린 시간에 넣지 않는다.
  constructor({ ttlMs = NARRATION_QUEUE_TTL_MS, now = () => performance.now(), getPausedMs = () => 0 } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.getPausedMs = getPausedMs;
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

  takeNext() {
    const nowTs = this.now();
    const droppedList = [];
    const drop = ({ entry, reason }) => droppedList.push({ entry, reason, waitedMs: this.readWaitedMs({ entry, nowTs }) });
    let aliveList = [];
    for (const entry of this.entryList) {
      if (isExpirable(entry) && this.readWaitedMs({ entry, nowTs }) > this.ttlMs) {
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

  clear() {
    this.entryList = [];
  }
}
