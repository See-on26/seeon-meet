import { QUEUE_DROP_REASON_MAP } from './narration-queue.js';

// 해설 기록 카드(자막)를 그 해설의 소리가 나기 시작할 때 띄운다. 해설 글은 소리보다 먼저 나와(TTS 합성·재생 대기),
// 글이 나오자마자 카드를 띄우면 자막이 소리보다 앞섰다(동시 모드 약 1초, 균형 모드는 지연 재생이라 10초 가까이).
// TTS 가 실패해 소리 없이 넘어가는 해설은 글이라도 보이게 그때 띄우고, 재생하지 못하고 버린 해설은 띄우지 않는다.
const SHOW_ON_DROP_REASON_SET = new Set([QUEUE_DROP_REASON_MAP.ttsFailed]);

function toCardKey({ ts, text }) {
  return `${ts ?? ''}\u0000${text ?? ''}`;
}

export class CaptionCardGate {
  constructor({ showCard }) {
    this.showCard = showCard;
    this.pendingCardMap = new Map();
  }

  hold({ entry, card }) {
    this.pendingCardMap.set(toCardKey(entry), card);
  }

  // 재생이 시작된 해설의 카드를 띄운다. 들고 있던 카드가 없으면(이미 띄웠거나 버림) false.
  release({ entry }) {
    const key = toCardKey(entry);
    const card = this.pendingCardMap.get(key);
    if (!card) return false;
    this.pendingCardMap.delete(key);
    this.showCard(card);
    return true;
  }

  drop({ entry, reason }) {
    if (SHOW_ON_DROP_REASON_SET.has(reason)) return this.release({ entry });
    this.pendingCardMap.delete(toCardKey(entry));
    return false;
  }

  clear() {
    this.pendingCardMap.clear();
  }
}
