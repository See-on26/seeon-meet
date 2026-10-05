import { NARRATION_CLASS_MAP } from '../constants.js';

// 사용자가 직접 물은 답은 틈 추론·지연 일정을 건너뛰고 지금 재생 위치에 바로 넣는다.
export function isImmediateCaption(payload) {
  return payload?.narrationClass === NARRATION_CLASS_MAP.userCommand;
}

// 무발화 해설은 그 침묵 동안 들려야 한다. 감지 시점 뒤의 틈은 발표자가 다시 말한 뒤라서 틈을 고르지 않고 감지 시점에 끼운다.
export function isAnchoredCaption(payload) {
  return payload?.narrationClass === NARRATION_CLASS_MAP.silenceBased;
}

// 마이크 질문을 녹음하고 답이 나올 때까지 자동 해설이 사용자 말·답과 겹치지 않게 잠시 모아 둔다.
// 질문이 겹칠 수 있어 보류 횟수를 센다. 앞 질문이 끝나도 뒤 질문의 보류는 유지된다.
export class NarrationHoldGate {
  constructor({ deliver, deliverList = null }) {
    this.deliver = deliver;
    this.deliverList = deliverList;
    this.holdCount = 0;
    this.heldList = [];
  }

  get isHeld() {
    return this.holdCount > 0;
  }

  submit(item) {
    if (this.isHeld) {
      this.heldList.push(item);
      return false;
    }
    this.deliver(item);
    return true;
  }

  hold() {
    this.holdCount += 1;
  }

  release() {
    this.holdCount = Math.max(0, this.holdCount - 1);
    if (this.isHeld) return 0;
    const heldList = this.heldList;
    this.heldList = [];
    if (!heldList.length) return 0;
    if (this.deliverList) this.deliverList(heldList);
    else for (const item of heldList) this.deliver(item);
    return heldList.length;
  }

  clear() {
    this.holdCount = 0;
    this.heldList = [];
  }
}
