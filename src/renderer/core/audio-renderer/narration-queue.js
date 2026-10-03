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

// 전환 고지는 순위가 가장 높아 앞 해설 하나만 기다리지만, 품질 모드 해설은 최대 12초라 시간으로 버리면 고지를 놓친다.
// 지난 슬라이드의 고지는 다음 슬라이드 고지가 꺼내질 때 슬라이드가 달라 버려진다.
function isExpirable(entry) {
  return !isImmediateCaption(entry) && !isPageTransition(entry);
}

function hasSlideLabel(entry) {
  return entry.slideLabel !== null && entry.slideLabel !== undefined && entry.slideLabel !== '';
}

function isOtherSlide({ entry, slideEntry }) {
  return hasSlideLabel(entry) && String(entry.slideLabel) !== String(slideEntry.slideLabel);
}

function compareEntry(left, right) {
  return readNarrationPriority(left) - readNarrationPriority(right) || left.seq - right.seq;
}

export class NarrationQueue {
  constructor({ ttlMs = NARRATION_QUEUE_TTL_MS, now = () => performance.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entryList = [];
    this.nextSeq = 0;
  }

  push(entry) {
    const dueAt = Number.isFinite(entry.dueAt) ? entry.dueAt : this.now();
    this.entryList.push({ ...entry, dueAt, seq: this.nextSeq });
    this.nextSeq += 1;
  }

  takeNext() {
    const nowTs = this.now();
    const droppedList = [];
    let aliveList = [];
    for (const entry of this.entryList) {
      const waitedMs = nowTs - entry.dueAt;
      if (isExpirable(entry) && waitedMs > this.ttlMs) {
        droppedList.push({ entry, reason: QUEUE_DROP_REASON_MAP.expired, waitedMs });
      } else {
        aliveList.push(entry);
      }
    }
    if (!aliveList.length) {
      this.entryList = [];
      return { entry: null, droppedList };
    }

    const next = aliveList.reduce((best, entry) => (compareEntry(entry, best) < 0 ? entry : best));
    aliveList = aliveList.filter((entry) => entry !== next);
    // 전환 고지가 앞질러 나가면 그보다 먼저 들어온 지난 슬라이드 해설은 새 슬라이드 설명처럼 들린다.
    if (isPageTransition(next) && hasSlideLabel(next)) {
      const keptList = [];
      for (const entry of aliveList) {
        if (entry.seq < next.seq && !isImmediateCaption(entry) && isOtherSlide({ entry, slideEntry: next })) {
          droppedList.push({ entry, reason: QUEUE_DROP_REASON_MAP.slideChanged, waitedMs: nowTs - entry.dueAt });
        } else {
          keptList.push(entry);
        }
      }
      aliveList = keptList;
    }
    this.entryList = aliveList;
    return { entry: next, droppedList };
  }

  get size() {
    return this.entryList.length;
  }

  clear() {
    this.entryList = [];
  }
}
