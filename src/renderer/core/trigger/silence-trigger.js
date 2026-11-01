// 평가 정의(「성능 평가 방식」)의 무발화 길이 5초. 평가 쪽 기준이라 그대로 두고, 실시간 발동에는 아래 값을 쓴다.
export const SILENCE_TRIGGER_MS = 5000;
// 실시간 발동 임계. 회의 소리가 작아 바닥 잡음이 말소리 문턱(0.02) 근처에 붙으면 숨소리·잡음 한 틱이 무음 셈을
// 다시 시작시켜, 발표자가 5초 쉬어도 5초를 끝까지 재지 못한다(실측 최대 3.6초). 그래서 평가 정의보다 짧게 둔다.
// 2.5초까지 줄이면 말하는 도중의 짧은 쉼에도 발동한다.
export const LIVE_SILENCE_TRIGGER_MS = 3500;
// 침묵 직전 발화로 "화면을 보라는 단서"를 찾는다. 무음(실시간 3.5초)을 빼면 약 11초 분량의 발화가 들어간다.
export const SILENCE_TRANSCRIPT_WINDOW_MS = 15000;

export const SILENCE_SKIP_REASON_MAP = {
  noScreen: 'no_screen',
  noUtterance: 'no_utterance',
  budget: 'budget',
};

export const SILENCE_SKIP_LABEL_MAP = {
  [SILENCE_SKIP_REASON_MAP.noScreen]: '공유 화면 없음',
  [SILENCE_SKIP_REASON_MAP.noUtterance]: '직전 발화 없음',
  [SILENCE_SKIP_REASON_MAP.budget]: '어절 예산 부족',
};

// 무음 한 구간에 한 번만 발동한다. 말소리가 다시 들려 마지막 말소리 시각이 바뀌어야 다음 구간이 열린다.
export class SilenceTrigger {
  constructor({ thresholdMs = SILENCE_TRIGGER_MS } = {}) {
    this.thresholdMs = thresholdMs;
    this.armedSince = 0;
    this.firedHeardAt = null;
  }

  // 캡처를 다시 시작하면 그 전에 들은 말소리는 세지 않는다.
  reset({ nowPerf = 0 } = {}) {
    this.armedSince = nowPerf;
    this.firedHeardAt = null;
  }

  // 마이크 질문·일시정지 중(isSuspended)에는 세지 않는다. 그 사이 흐른 무음도 무음 구간으로 치지 않도록
  // 끝난 뒤에는 새로 들린 말소리부터 다시 센다.
  update({ nowPerf, lastHeardAt, isSuspended = false }) {
    if (isSuspended) {
      this.reset({ nowPerf });
      return false;
    }
    if (!(lastHeardAt > this.armedSince)) return false;
    if (lastHeardAt === this.firedHeardAt) return false;
    if (nowPerf - lastHeardAt < this.thresholdMs) return false;
    this.firedHeardAt = lastHeardAt;
    return true;
  }
}

export function evaluateSilencePrecondition({ slideLabel, recentTranscript, wordBudget }) {
  if (!slideLabel) return { isReady: false, reason: SILENCE_SKIP_REASON_MAP.noScreen };
  if (!recentTranscript || !recentTranscript.trim()) {
    return { isReady: false, reason: SILENCE_SKIP_REASON_MAP.noUtterance };
  }
  if (!wordBudget || wordBudget.isDroppable) return { isReady: false, reason: SILENCE_SKIP_REASON_MAP.budget };
  return { isReady: true, reason: null };
}
