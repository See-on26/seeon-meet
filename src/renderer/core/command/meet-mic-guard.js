import { SELF_MIC_STATE_MAP } from '../roi/roi-store.js';

// ROI 는 0.5초 간격으로 갱신되고 중계에서 더 늦어질 수 있어, 한 번만 보지 않고 바뀔 때까지 몇 번 확인한다.
const VERIFY_POLL_MS = 250;
const VERIFY_POLL_COUNT = 6;

// 사용자 마이크는 Meet 도 쓰고 있어, 앱에 하는 질문이 회의 참가자에게 들리지 않게 잠시 끈다.
// 원래 꺼져 있던 마이크를 켜는 일이 없도록, 우리가 끄기 토글을 보냈고 끝날 때 실제로 꺼져 있을 때만 되돌린다.
export class MeetMicGuard {
  constructor({ getSelfMicState, toggleMeetMic, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), notify }) {
    this.getSelfMicState = getSelfMicState;
    this.toggleMeetMic = toggleMeetMic;
    this.wait = wait;
    this.notify = notify;
    this.hasToggledOff = false;
  }

  async waitForState(expectedState) {
    for (let attempt = 0; attempt < VERIFY_POLL_COUNT; attempt += 1) {
      await this.wait(VERIFY_POLL_MS);
      if (this.getSelfMicState() === expectedState) return true;
    }
    return false;
  }

  async muteForRecording() {
    this.hasToggledOff = false;
    const state = this.getSelfMicState();
    if (state === SELF_MIC_STATE_MAP.unknown) {
      this.notify('회의 마이크 상태를 확인하지 못했어요');
      return false;
    }
    if (state === SELF_MIC_STATE_MAP.muted) return false;
    await this.toggleMeetMic();
    this.hasToggledOff = true;
    const isMuted = await this.waitForState(SELF_MIC_STATE_MAP.muted);
    if (!isMuted) this.notify('회의 마이크를 끄지 못했어요');
    return isMuted;
  }

  async restoreAfterRecording() {
    if (!this.hasToggledOff) return;
    this.hasToggledOff = false;
    if (this.getSelfMicState() !== SELF_MIC_STATE_MAP.muted) return;
    await this.toggleMeetMic();
    const isOn = await this.waitForState(SELF_MIC_STATE_MAP.on);
    if (!isOn) this.notify('회의 마이크를 다시 켜지 못했어요');
  }
}
