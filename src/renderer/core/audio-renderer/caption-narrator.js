import { SIC_CATCHUP_MIN_RATE, SIC_CATCHUP_MAX_RATE, SIC_CATCHUP_RATE_PER_SEC } from '../constants.js';
import { NarrationQueue, QUEUE_DROP_REASON_MAP, readEntryAudio } from './narration-queue.js';
import { isImmediateCaption } from './narration-entry.js';
import {
  computeGainFromDecibel, createSpatialPanner, DEFAULT_DUCK_DB, ANSWER_OVERLAY_POSITION_X, buildPlayStartInfo,
} from './narration-mixer.js';
import { defaultUiText } from '../i18n/ui-text.js';

const START_LEAD_SEC = 0.02;
// 회의를 멈추고 다시 틀 때 소리를 한 번에 끊지 않고 이 시간 동안 줄이고 키운다(뚝 끊기는 소리를 없앤다).
const PAUSE_FADE_MS = 80;
const PAUSE_FADE_STEP_MS = 10;

export function computeCatchupRate({ pausedSec, minRate, maxRate, ratePerSec }) {
  return Math.min(maxRate, Math.max(minRate, minRate + pausedSec * ratePerSec));
}

export class CaptionNarrator {
  constructor({ getLiveVideo, onStatus = null, onDrop = null, onPlayStart = null, getRateRange = null, isCatchupDelegated = null,
    createAudioContext = () => new AudioContext(), now = () => performance.now(), wallNow = () => Date.now(),
    isEntryEnabled = () => true, prepareAudio = readEntryAudio, getPlaybackTimeMs = () => null, t = defaultUiText,
    waitForInsertGap = null, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) }) {
    this.getLiveVideo = getLiveVideo;
    // 자동 해설로 회의를 막 멈추려 할 때 부른다. 돌아오면 멈춰도 되는 때다(성능 모드는 말 틈까지 기다린다).
    this.waitForInsertGap = waitForInsertGap || (async () => {});
    this.sleep = sleep;
    this.fadeToken = 0;
    this.t = t;
    this.prepareAudio = prepareAudio;
    this.onStatus = onStatus || (() => {});
    this.onDrop = onDrop || (() => {});
    this.onPlayStart = onPlayStart || (() => {});
    this.wallNow = wallNow;
    this.createAudioContext = createAudioContext;
    this.now = now;
    this.getRateRange = getRateRange
      || (() => ({ rateMin: SIC_CATCHUP_MIN_RATE, rateMax: SIC_CATCHUP_MAX_RATE }));
    this.isCatchupDelegated = isCatchupDelegated || (() => false);
    this.audioContext = null;
    this.ttsGainNode = null;
    this.analyserNode = null;
    this.liveTapSource = null;
    this.answerPanner = null;
    this.currentSource = null;
    this.currentEntry = null;
    this.currentStartSec = 0;
    this.playToken = 0;
    this.pausedTotalMs = 0;
    this.pauseStartedAt = null;
    this.queue = new NarrationQueue({ now, getPausedMs: () => this.readPausedMs(), isEntryEnabled, getPlaybackTimeMs });
    // isInserting: 자동 해설 때문에 회의 영상을 멈춘 상태. isOverlaying: 질문 답을 회의 소리를 줄인 채 겹쳐 트는 상태.
    this.isInserting = false;
    this.isOverlaying = false;
    this.isCatchingUp = false;
    this.narratedSec = 0;
    this.currentNarrationSec = 0;
    this.catchupTimer = null;
  }

  start(stream) {
    this.audioContext = this.createAudioContext();
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 1024;

    this.ttsGainNode = this.audioContext.createGain();
    this.ttsGainNode.connect(this.audioContext.destination);
    this.ttsGainNode.connect(this.analyserNode);
    this.answerPanner = createSpatialPanner({ audioContext: this.audioContext, positionX: ANSWER_OVERLAY_POSITION_X });
    this.answerPanner.connect(this.ttsGainNode);

    try {
      if (stream.getAudioTracks().length) {
        this.liveTapSource = this.audioContext.createMediaStreamSource(stream);
        this.liveTapSource.connect(this.analyserNode);
      }
    } catch (error) {
      this.onStatus(this.t('narration.tapFailed', { message: error.message }));
    }
  }

  stop() {
    this._cancelCatchup();
    this.playToken += 1;
    // 소리가 나기 전(합성 중)에 멈춘 해설과 대기 줄에 남은 해설은 사용자가 듣지 못했다.
    const unplayedList = [
      ...(this.currentEntry && !this.currentSource ? [this.currentEntry] : []), ...this.queue.drain(),
    ];
    try { this.currentSource?.stop(); } catch {  }
    this.currentSource = null;
    this.currentEntry = null;
    for (const entry of unplayedList) this.onDrop({ entry, reason: QUEUE_DROP_REASON_MAP.stopped });
    this._closePause();
    this.isInserting = false;
    this.isOverlaying = false;
    this.narratedSec = 0;
    this.currentNarrationSec = 0;
    const video = this.getLiveVideo();
    if (video) { video.playbackRate = 1.0; this._setVolume(video, 1.0); }
    try { this.liveTapSource?.disconnect(); } catch {  }
    this.liveTapSource = null;
    if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }
    this.answerPanner = null;
    this.ttsGainNode = null;
    this.analyserNode = null;
    this.onStatus('');
  }

  // entry: { wavArrayBuffer, narrationClass, slideLabel, text, ts, eventTimeMs, dueAt }
  queueCaption(entry) {
    this.queueCaptionList([entry]);
  }

  // 여러 해설을 한꺼번에 넣은 뒤 한 번만 꺼낸다. 하나씩 넣으면 첫 항목이 순위 비교 없이 바로 재생된다.
  queueCaptionList(entryList) {
    if (!entryList.length) return;
    if (!this.audioContext) {
      for (const entry of entryList) this.onDrop({ entry, reason: QUEUE_DROP_REASON_MAP.stopped });
      return;
    }
    for (const entry of entryList) this.queue.push(entry);
    // 질문 답(수동 AD)도 재생 중인 해설을 끊지 않는다. 끝나면 대기 줄 순위(질문 답이 0순위)대로 바로 이어 재생한다.
    if (!this.currentEntry) this._beginNext();
  }

  // 자동 해설 때문에 회의 영상을 멈춘 누적 시간. 그동안 재생 위치가 서 있으므로 대기 줄은 기다린 시간에서 뺀다.
  readPausedMs() {
    const runningMs = this.pauseStartedAt === null ? 0 : this.now() - this.pauseStartedAt;
    return this.pausedTotalMs + runningMs;
  }

  // 끊기거나 멈춘 재생의 비동기 디코딩·ended 가 늦게 와도 다음 재생을 건드리지 않게 재생마다 표를 나눠 준다.
  async _beginNext() {
    const { entry, droppedList } = this.queue.takeNext();
    for (const drop of droppedList) this.onDrop(drop);
    if (!entry) { this._finishPlayback(); return; }
    const isAnswer = isImmediateCaption(entry);
    this.playToken += 1;
    const token = this.playToken;
    this.currentEntry = entry;
    if (isAnswer) {
      this._enterOverlay();
    } else {
      // 회의를 막 멈출 때만 말 틈을 기다린다. 이미 멈춰 있으면 바로 이어 튼다.
      if (!this.isInserting) await this.waitForInsertGap().catch(() => {});
      if (token !== this.playToken) return;
      await this._enterInsertion();
      if (token !== this.playToken) return;
    }
    try {
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      // 교차 모드는 이미 회의를 멈춘 뒤라 합성하는 동안 회의가 해설 자리를 지나가지 않는다.
      const wavArrayBuffer = await this.prepareAudio(entry);
      if (token !== this.playToken) return;
      if (!wavArrayBuffer) {
        this.onDrop({ entry, reason: QUEUE_DROP_REASON_MAP.ttsFailed });
        this.currentNarrationSec = 0;
        this._onNarrationEnded();
        return;
      }
      const audioBuffer = await this.audioContext.decodeAudioData(wavArrayBuffer);
      if (token !== this.playToken) return;
      this.currentNarrationSec = audioBuffer.duration || 0;
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(isAnswer ? this.answerPanner : this.ttsGainNode);
      source.onended = () => { if (token === this.playToken) this._onNarrationEnded(); };
      this.currentSource = source;
      this.currentStartSec = this.audioContext.currentTime + START_LEAD_SEC;
      source.start(this.currentStartSec);
      this._notifyPlayStart({ entry, durationSec: this.currentNarrationSec });
      this.onStatus(this.t(isAnswer ? 'narration.answerPlaying' : 'narration.playing'));
    } catch (error) {
      if (token !== this.playToken) return;
      this.onStatus(this.t('narration.playFailed', { message: error.message }));
      this.currentNarrationSec = 0;
      this._onNarrationEnded();
    }
  }

  // 알림을 받는 쪽이 실패해도 재생은 계속한다.
  _notifyPlayStart({ entry, durationSec }) {
    try {
      this.onPlayStart(buildPlayStartInfo({ entry, durationSec, wallMs: this.wallNow() + START_LEAD_SEC * 1000 }));
    } catch (error) {
      console.warn(`[narrator] 재생 시작 알림 실패(무시): ${error.message}`);
    }
  }

  _onNarrationEnded() {
    if (this.isInserting) this.narratedSec += this.currentNarrationSec;
    this.currentNarrationSec = 0;
    this.currentSource = null;
    this.currentEntry = null;
    this._beginNext();
  }

  async _enterInsertion() {
    if (this.isOverlaying) this._leaveOverlay();
    if (this.isInserting) return;
    this.isInserting = true;
    this.narratedSec = 0;
    this._cancelCatchup();
    const video = this.getLiveVideo();
    // 줄이는 도중에 멈추면(stop) 영상을 멈추지 않는다. stop 이 소리를 이미 되돌렸다.
    if (video && !(await this._fadeVolume(video, 0))) return;
    this.pauseStartedAt = this.now();
    // 멈춘 뒤에는 소리 크기를 되돌려 둔다. 다른 곳(지연 버퍼)이 영상을 다시 틀어도 소리가 0 으로 남지 않는다.
    if (video) { video.pause(); video.playbackRate = 1.0; this._setVolume(video, 1.0); }
  }

  _endInsertion() {
    this.isInserting = false;
    this._closePause();
    const narratedSec = this.narratedSec;
    this.narratedSec = 0;
    this._startCatchup(narratedSec);
  }

  // 질문 답은 회의를 멈추지 않는다. 회의 소리를 동시 모드 덕킹과 같은 −12dB 로 줄이고 답은 오른쪽에서 들려준다.
  _enterOverlay() {
    if (this.isInserting) this._endInsertion();
    if (this.isOverlaying) return;
    this.isOverlaying = true;
    const video = this.getLiveVideo();
    if (video) this._setVolume(video, computeGainFromDecibel({ decibel: DEFAULT_DUCK_DB }));
  }

  _leaveOverlay() {
    this.isOverlaying = false;
    const video = this.getLiveVideo();
    if (video) this._setVolume(video, 1.0);
  }

  // 진행 중인 줄이기·키우기를 멈추고 소리 크기를 바로 정한다.
  _setVolume(video, volume) {
    this.fadeToken += 1;
    video.volume = volume;
  }

  // 소리를 목표 크기까지 나눠 바꾼다. 도중에 다른 크기 지정이 오면 그만두고 false 를 돌려준다.
  async _fadeVolume(video, targetVolume) {
    this.fadeToken += 1;
    const token = this.fadeToken;
    const fromVolume = video.volume;
    const stepCount = Math.max(1, Math.round(PAUSE_FADE_MS / PAUSE_FADE_STEP_MS));
    for (let step = 1; step <= stepCount; step += 1) {
      await this.sleep(PAUSE_FADE_STEP_MS);
      if (token !== this.fadeToken) return false;
      video.volume = fromVolume + (targetVolume - fromVolume) * (step / stepCount);
    }
    return true;
  }

  _finishPlayback() {
    if (this.isOverlaying) { this._leaveOverlay(); this.onStatus(''); }
    if (this.isInserting) this._endInsertion();
  }

  _startCatchup(pausedSec) {
    const video = this.getLiveVideo();
    if (!video) return;
    this._setVolume(video, 0);
    video.play().catch(() => {});
    this._fadeVolume(video, 1.0);
    if (this.isCatchupDelegated()) { this.onStatus(''); return; }
    if (pausedSec <= 0.05) { video.playbackRate = 1.0; this.onStatus(''); return; }
    const { rateMin, rateMax } = this.getRateRange();
    const rate = computeCatchupRate({
      pausedSec, minRate: rateMin, maxRate: rateMax, ratePerSec: SIC_CATCHUP_RATE_PER_SEC,
    });

    if (rate <= 1.0) { video.playbackRate = 1.0; this.onStatus(''); return; }
    video.playbackRate = rate;
    this.isCatchingUp = true;
    this.onStatus(this.t('narration.catchup', { rate: rate.toFixed(2) }));

    const catchupMs = (pausedSec / (rate - 1)) * 1000;
    this.catchupTimer = setTimeout(() => {
      const current = this.getLiveVideo();
      if (current) current.playbackRate = 1.0;
      this.isCatchingUp = false;
      this.catchupTimer = null;
      this.onStatus('');
    }, catchupMs);
  }

  _closePause() {
    if (this.pauseStartedAt === null) return;
    this.pausedTotalMs += this.now() - this.pauseStartedAt;
    this.pauseStartedAt = null;
  }

  _cancelCatchup() {
    if (this.catchupTimer) { clearTimeout(this.catchupTimer); this.catchupTimer = null; }
    this.isCatchingUp = false;
  }

  getAnalyser() {
    return this.analyserNode;
  }

  getSicState() {
    const video = this.getLiveVideo();
    return {
      isInserting: this.isInserting || this.isOverlaying,
      isCatchingUp: this.isCatchingUp,
      playbackRate: video ? video.playbackRate : 1.0,
    };
  }
}
