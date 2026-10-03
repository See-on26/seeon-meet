import { SELF_MIC_STATE_MAP } from '../roi/roi-store.js';

const VERIFY_DELAY_MS = 500;

// 사용자 마이크는 Meet 도 쓰고 있어, 앱에 하는 질문이 회의 참가자에게 들리지 않게 잠시 끈다.
// 원래 꺼져 있던 마이크를 켜는 일이 없도록 우리가 끈 경우에만 복원한다.
export class MeetMicGuard {
  constructor({ getSelfMicState, toggleMeetMic, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), notify }) {
    this.getSelfMicState = getSelfMicState;
    this.toggleMeetMic = toggleMeetMic;
    this.wait = wait;
    this.notify = notify;
    this.isMutedByUs = false;
  }

  async muteForRecording() {
    this.isMutedByUs = false;
    const state = this.getSelfMicState();
    if (state === SELF_MIC_STATE_MAP.unknown) {
      this.notify('회의 마이크 상태를 확인하지 못했어요');
      return false;
    }
    if (state === SELF_MIC_STATE_MAP.muted) return false;
    await this.toggleMeetMic();
    await this.wait(VERIFY_DELAY_MS);
    if (this.getSelfMicState() !== SELF_MIC_STATE_MAP.muted) {
      this.notify('회의 마이크를 끄지 못했어요');
      return false;
    }
    this.isMutedByUs = true;
    return true;
  }

  async restoreAfterRecording() {
    if (!this.isMutedByUs) return;
    this.isMutedByUs = false;
    await this.toggleMeetMic();
    await this.wait(VERIFY_DELAY_MS);
    if (this.getSelfMicState() !== SELF_MIC_STATE_MAP.on) this.notify('회의 마이크를 다시 켜지 못했어요');
  }
}
