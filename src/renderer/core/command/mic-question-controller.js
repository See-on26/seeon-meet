import { defaultUiText } from '../i18n/ui-text.js';

export const MIC_PHASE_MAP = {
  idle: 'idle',
  starting: 'starting',
  recording: 'recording',
  finishing: 'finishing',
};

const CANCEL_TEXT_KEY_MAP = {
  no_voice: 'mic.noVoice',
  permission: 'mic.permissionNeeded',
  error: 'mic.startFailed',
  cancelled: 'mic.cancelled',
};

// 마이크 질문 한 번을 시작부터 마무리까지 한 줄로 세운다. 시작·마무리 중(Meet 마이크 확인 대기 등)에
// 다시 누르면 무시해, 세션이 겹쳐 Meet 마이크 토글이 두 번 가거나 보류 게이트가 엉키지 않게 한다.
export class MicQuestionController {
  // readStartBlockedTextKey 는 지금 질문을 받을 수 없으면 그 까닭의 문구 키(캡처 전·일시정지 중), 받을 수 있으면 null 이다.
  constructor({ recorder, readStartBlockedTextKey, beginSession, endSession, announce, setUi, onQuestionAudio,
    onAnswerSettled = () => {}, t = defaultUiText }) {
    this.recorder = recorder;
    this.readStartBlockedTextKey = readStartBlockedTextKey;
    this.beginSession = beginSession;
    this.endSession = endSession;
    this.announce = announce;
    this.setUi = setUi;
    this.onQuestionAudio = onQuestionAudio;
    this.onAnswerSettled = onAnswerSettled;
    this.t = t;
    this.phase = MIC_PHASE_MAP.idle;
    this.isCancelRequested = false;
  }

  async toggle() {
    if (this.phase === MIC_PHASE_MAP.starting || this.phase === MIC_PHASE_MAP.finishing) return false;
    if (this.phase === MIC_PHASE_MAP.recording) {
      this.recorder.toggle();
      return true;
    }
    const blockedTextKey = this.readStartBlockedTextKey();
    if (blockedTextKey) {
      this.announce(this.t(blockedTextKey));
      return false;
    }
    this.phase = MIC_PHASE_MAP.starting;
    this.isCancelRequested = false;
    await this.beginSession();
    this.announce(this.t('mic.startPrompt'));
    const isStarted = await this.recorder.start();
    if (!isStarted || this.phase !== MIC_PHASE_MAP.starting) return isStarted;
    this.phase = MIC_PHASE_MAP.recording;
    this.setUi(true);
    if (this.isCancelRequested) this.recorder.cancel();
    return true;
  }

  async closeSession({ isAwaitingAnswer = false } = {}) {
    this.phase = MIC_PHASE_MAP.finishing;
    this.setUi(false);
    await this.endSession({ isAwaitingAnswer });
    this.phase = MIC_PHASE_MAP.idle;
  }

  // 녹음이 끝나도 답이 나올 때까지 자동 해설 보류를 유지한다. 먼저 풀면 보류됐던 해설이 재생되다 답에 끊긴다.
  async handleFinish({ buffer, startTs }) {
    await this.closeSession({ isAwaitingAnswer: true });
    try {
      await this.onQuestionAudio({ buffer, startTs });
    } finally {
      this.onAnswerSettled();
    }
  }

  async handleCancel({ reason }) {
    await this.closeSession();
    this.announce(this.t(CANCEL_TEXT_KEY_MAP[reason] || CANCEL_TEXT_KEY_MAP.cancelled));
  }

  // 캡처를 멈출 때 진행 중인 녹음을 버린다. 시작 중이면 시작이 끝나는 대로 버린다.
  cancel() {
    if (this.phase === MIC_PHASE_MAP.recording) this.recorder.cancel();
    else if (this.phase === MIC_PHASE_MAP.starting) this.isCancelRequested = true;
  }
}
