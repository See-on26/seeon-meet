import { SIC_CATCHUP_MIN_RATE, SIC_CATCHUP_MAX_RATE, SIC_CATCHUP_RATE_PER_SEC } from '../constants.js';
import { NarrationQueue, shouldInterrupt, QUEUE_DROP_REASON_MAP, readEntryAudio } from './narration-queue.js';
import { isImmediateCaption } from './narration-entry.js';
import {
  computeGainFromDecibel, createSidePanner, DEFAULT_DUCK_DB, NARRATION_PAN_X,
} from './narration-mixer.js';

const START_LEAD_SEC = 0.02;

export function computeCatchupRate({ pausedSec, minRate, maxRate, ratePerSec }) {
  return Math.min(maxRate, Math.max(minRate, minRate + pausedSec * ratePerSec));
}

export class CaptionNarrator {
  constructor({ getLiveVideo, onStatus = null, onDrop = null, getRateRange = null, isCatchupDelegated = null,
    createAudioContext = () => new AudioContext(), now = () => performance.now(),
    isEntryEnabled = () => true, prepareAudio = readEntryAudio }) {
    this.getLiveVideo = getLiveVideo;
    this.prepareAudio = prepareAudio;
    this.onStatus = onStatus || (() => {});
    this.onDrop = onDrop || (() => {});
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
    this.queue = new NarrationQueue({ now, getPausedMs: () => this.readPausedMs(), isEntryEnabled });
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
    this.answerPanner = createSidePanner({ audioContext: this.audioContext, positionX: NARRATION_PAN_X });
    this.answerPanner.connect(this.ttsGainNode);

    try {
      if (stream.getAudioTracks().length) {
        this.liveTapSource = this.audioContext.createMediaStreamSource(stream);
        this.liveTapSource.connect(this.analyserNode);
      }
    } catch (error) {
      this.onStatus(`파형 탭 실패(무시): ${error.message}`);
    }
  }

  stop() {
    this._cancelCatchup();
    this.playToken += 1;
    try { this.currentSource?.stop(); } catch {  }
    this.currentSource = null;
    this.currentEntry = null;
    this.queue.clear();
    this._closePause();
    this.isInserting = false;
    this.isOverlaying = false;
    this.narratedSec = 0;
    this.currentNarrationSec = 0;
    const video = this.getLiveVideo();
    if (video) { video.playbackRate = 1.0; video.volume = 1.0; }
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
    if (!this.audioContext || !entryList.length) return;
    for (const entry of entryList) this.queue.push(entry);
    // 꺼진 분류의 질문 답은 어차피 버려지므로 재생 중인 해설을 끊지 않는다.
    const isInterrupting = entryList.some((entry) => this.queue.isEntryEnabled(entry)
      && shouldInterrupt({ currentEntry: this.currentEntry, incomingEntry: entry }));
    if (isInterrupting) {
      this._interruptCurrent();
      return;
    }
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
    if (isAnswer) this._enterOverlay(); else this._enterInsertion();
    this.playToken += 1;
    const token = this.playToken;
    this.currentEntry = entry;
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
      this.onStatus(isAnswer ? '질문 답 재생 중(회의음 줄임)…' : '캡션 내레이션 재생 중…');
    } catch (error) {
      if (token !== this.playToken) return;
      this.onStatus(`내레이션 재생 실패: ${error.message}`);
      this.currentNarrationSec = 0;
      this._onNarrationEnded();
    }
  }

  _onNarrationEnded() {
    if (this.isInserting) this.narratedSec += this.currentNarrationSec;
    this.currentNarrationSec = 0;
    this.currentSource = null;
    this.currentEntry = null;
    this._beginNext();
  }

  // 질문 답이 자동 해설을 끊는다. 멈춰 있던 만큼은 따라잡기에 넣는다.
  _interruptCurrent() {
    const entry = this.currentEntry;
    if (this.isInserting && this.currentSource && this.audioContext) {
      const playedSec = Math.max(0, this.audioContext.currentTime - this.currentStartSec);
      this.narratedSec += Math.min(playedSec, this.currentNarrationSec);
    }
    this.playToken += 1;
    try { this.currentSource?.stop(); } catch {  }
    this.currentSource = null;
    this.currentEntry = null;
    this.currentNarrationSec = 0;
    if (entry) this.onDrop({ entry, reason: QUEUE_DROP_REASON_MAP.interrupted });
    this._beginNext();
  }

  _enterInsertion() {
    if (this.isOverlaying) this._leaveOverlay();
    if (this.isInserting) return;
    this.isInserting = true;
    this.pauseStartedAt = this.now();
    this.narratedSec = 0;
    this._cancelCatchup();
    const video = this.getLiveVideo();
    if (video) { video.pause(); video.playbackRate = 1.0; }
  }

  _endInsertion() {
    this.isInserting = false;
    this._closePause();
    const narratedSec = this.narratedSec;
    this.narratedSec = 0;
    this._startCatchup(narratedSec);
  }

  // 질문 답은 회의를 멈추지 않는다. 회의 소리를 동시 모드 덕킹과 같은 −12dB 로 줄이고 답은 왼쪽에서 들려준다.
  _enterOverlay() {
    if (this.isInserting) this._endInsertion();
    if (this.isOverlaying) return;
    this.isOverlaying = true;
    const video = this.getLiveVideo();
    if (video) video.volume = computeGainFromDecibel({ decibel: DEFAULT_DUCK_DB });
  }

  _leaveOverlay() {
    this.isOverlaying = false;
    const video = this.getLiveVideo();
    if (video) video.volume = 1.0;
  }

  _finishPlayback() {
    if (this.isOverlaying) { this._leaveOverlay(); this.onStatus(''); }
    if (this.isInserting) this._endInsertion();
  }

  _startCatchup(pausedSec) {
    const video = this.getLiveVideo();
    if (!video) return;
    video.play().catch(() => {});
    if (this.isCatchupDelegated()) { this.onStatus(''); return; }
    if (pausedSec <= 0.05) { video.playbackRate = 1.0; this.onStatus(''); return; }
    const { rateMin, rateMax } = this.getRateRange();
    const rate = computeCatchupRate({
      pausedSec, minRate: rateMin, maxRate: rateMax, ratePerSec: SIC_CATCHUP_RATE_PER_SEC,
    });

    if (rate <= 1.0) { video.playbackRate = 1.0; this.onStatus(''); return; }
    video.playbackRate = rate;
    this.isCatchingUp = true;
    this.onStatus(`x${rate.toFixed(2)} 따라잡기`);

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
