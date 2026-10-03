import { NARRATION_CLASS_MAP } from '../constants.js';

// 사용자가 직접 물은 답은 틈 추론·지연 일정을 건너뛰고 지금 재생 위치에 바로 넣는다.
export function isImmediateCaption(payload) {
  return payload?.narrationClass === NARRATION_CLASS_MAP.userCommand;
}

// 무발화 해설은 그 침묵 동안 들려야 한다. 감지 시점 뒤의 틈은 발표자가 다시 말한 뒤라서 틈을 고르지 않고 감지 시점에 끼운다.
export function isAnchoredCaption(payload) {
  return payload?.narrationClass === NARRATION_CLASS_MAP.silenceBased;
}

// 마이크 질문을 녹음하는 동안 자동 해설이 사용자 말과 겹치지 않게 잠시 모아 둔다.
export class NarrationHoldGate {
  constructor({ deliver }) {
    this.deliver = deliver;
    this.isHeld = false;
    this.heldList = [];
  }

  submit(wavArrayBuffer) {
    if (this.isHeld) {
      this.heldList.push(wavArrayBuffer);
      return false;
    }
    this.deliver(wavArrayBuffer);
    return true;
  }

  hold() {
    this.isHeld = true;
  }

  release() {
    this.isHeld = false;
    const heldList = this.heldList;
    this.heldList = [];
    for (const wavArrayBuffer of heldList) this.deliver(wavArrayBuffer);
    return heldList.length;
  }

  clear() {
    this.isHeld = false;
    this.heldList = [];
  }
}
