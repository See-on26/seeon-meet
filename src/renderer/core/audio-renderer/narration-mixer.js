import { NarrationQueue, shouldInterrupt, QUEUE_DROP_REASON_MAP, readEntryAudio } from './narration-queue.js';

export const DEFAULT_DUCK_DB = -12;
const DEFAULT_RAMP_MS = 120;
const START_LEAD_SEC = 0.02;
// 소리 방향을 화면 배치와 맞춘다. 회의 화면은 왼쪽, SEEON 패널은 오른쪽이라 회의 소리는 왼쪽, 해설·답은 오른쪽에서 들린다.
const MEETING_PAN_X = -0.7;
export const NARRATION_PAN_X = 0.7;
const PANNER_DISTANCE_Z = -0.4;

// 재생 시작 알림에 싣는 정보. 음성 데이터는 빼고, 무엇이 언제부터 얼마 동안 들렸는지만 남긴다.
export function buildPlayStartInfo({ entry, durationSec, wallMs }) {
  return {
    entry: {
      text: entry.text,
      narrationClass: entry.narrationClass,
      slideLabel: entry.slideLabel ?? null,
      source: entry.source ?? null,
      ts: entry.ts ?? null,
      eventTimeMs: entry.eventTimeMs ?? null,
    },
    durationMs: Math.round((durationSec || 0) * 1000),
    wallMs,
  };
}

export function computeGainFromDecibel({ decibel }) {
  return 10 ** (decibel / 20);
}

export function createSidePanner({ audioContext, positionX }) {
  const panner = audioContext.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'linear';
  panner.positionX.value = positionX;
  panner.positionY.value = 0;
  panner.positionZ.value = PANNER_DISTANCE_Z;
  return panner;
}

export class NarrationMixer {
  constructor({ onStatus = null, onDrop = null, onPlayStart = null, duckDecibel = DEFAULT_DUCK_DB,
    createAudioContext = () => new AudioContext(), now = () => performance.now(), wallNow = () => Date.now(),
    isEntryEnabled = () => true, prepareAudio = readEntryAudio } = {}) {
    this.onStatus = onStatus || (() => {});
    this.prepareAudio = prepareAudio;
    this.onDrop = onDrop || (() => {});
    this.onPlayStart = onPlayStart || (() => {});
    this.wallNow = wallNow;
    this.duckDecibel = duckDecibel;
    this.createAudioContext = createAudioContext;
    this.audioContext = null;
    this.analyserNode = null;
    this.duckGainNode = null;
    this.narrationGainNode = null;
    this.meetingSource = null;
    this.currentSource = null;
    this.currentEntry = null;
    this.playToken = 0;
    this.queue = new NarrationQueue({ now, isEntryEnabled });
    this.isInserting = false;
  }

  start(stream) {
    this.audioContext = this.createAudioContext();
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 1024;

    this.narrationGainNode = this.audioContext.createGain();
    const narrationPanner = this.createPanner({ positionX: NARRATION_PAN_X });
    this.narrationGainNode.connect(narrationPanner);
    narrationPanner.connect(this.audioContext.destination);
    narrationPanner.connect(this.analyserNode);
    this.narrationPanner = narrationPanner;

    this.duckGainNode = this.audioContext.createGain();
    const meetingPanner = this.createPanner({ positionX: MEETING_PAN_X });
    this.duckGainNode.connect(meetingPanner);
    meetingPanner.connect(this.audioContext.destination);
    meetingPanner.connect(this.analyserNode);
    try {
      if (stream.getAudioTracks().length) {
        this.meetingSource = this.audioContext.createMediaStreamSource(stream);
        this.meetingSource.connect(this.duckGainNode);
      }
    } catch (error) {
      this.onStatus(`회의음 연결 실패(무시): ${error.message}`);
    }
  }

  createPanner({ positionX }) {
    return createSidePanner({ audioContext: this.audioContext, positionX });
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
    // 꺼진 분류의 질문 답은 어차피 버려지므로 재생 중인 해설을 끊지 않는다.
    const isInterrupting = entryList.some((entry) => this.queue.isEntryEnabled(entry)
      && shouldInterrupt({ currentEntry: this.currentEntry, incomingEntry: entry }));
    if (isInterrupting) {
      this.interruptCurrent();
      return;
    }
    if (!this.currentEntry) this.beginNext();
  }

  // 끊기거나 멈춘 재생의 비동기 디코딩·ended 가 늦게 와도 다음 재생을 건드리지 않게 재생마다 표를 나눠 준다.
  async beginNext() {
    const { entry, droppedList } = this.queue.takeNext();
    for (const drop of droppedList) this.onDrop(drop);
    if (!entry) { this.finishInsertion(); return; }
    if (!this.isInserting) {
      this.isInserting = true;
      this.duck({ isDucked: true });
    }
    this.playToken += 1;
    const token = this.playToken;
    this.currentEntry = entry;
    try {
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      const wavArrayBuffer = await this.prepareAudio(entry);
      if (token !== this.playToken) return;
      if (!wavArrayBuffer) {
        this.onDrop({ entry, reason: QUEUE_DROP_REASON_MAP.ttsFailed });
        this.handleNarrationEnded();
        return;
      }
      const audioBuffer = await this.audioContext.decodeAudioData(wavArrayBuffer);
      if (token !== this.playToken) return;
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.narrationGainNode);
      source.onended = () => { if (token === this.playToken) this.handleNarrationEnded(); };
      this.currentSource = source;
      source.start(this.audioContext.currentTime + START_LEAD_SEC);
      this.notifyPlayStart({ entry, durationSec: audioBuffer.duration });
      this.onStatus('내레이션 재생 중(회의음 덕킹)…');
    } catch (error) {
      if (token !== this.playToken) return;
      this.onStatus(`내레이션 재생 실패: ${error.message}`);
      this.handleNarrationEnded();
    }
  }

  // 알림을 받는 쪽이 실패해도 재생은 계속한다.
  notifyPlayStart({ entry, durationSec }) {
    try {
      this.onPlayStart(buildPlayStartInfo({ entry, durationSec, wallMs: this.wallNow() + START_LEAD_SEC * 1000 }));
    } catch (error) {
      console.warn(`[mix] 재생 시작 알림 실패(무시): ${error.message}`);
    }
  }

  handleNarrationEnded() {
    this.currentSource = null;
    this.currentEntry = null;
    this.beginNext();
  }

  interruptCurrent() {
    const entry = this.currentEntry;
    this.playToken += 1;
    try { this.currentSource?.stop(); } catch {  }
    this.currentSource = null;
    this.currentEntry = null;
    if (entry) this.onDrop({ entry, reason: QUEUE_DROP_REASON_MAP.interrupted });
    this.beginNext();
  }

  finishInsertion() {
    if (!this.isInserting) return;
    this.isInserting = false;
    this.duck({ isDucked: false });
    this.onStatus('');
  }

  duck({ isDucked }) {
    if (!this.duckGainNode || !this.audioContext) return;
    const targetGain = isDucked ? computeGainFromDecibel({ decibel: this.duckDecibel }) : 1.0;
    const now = this.audioContext.currentTime;
    this.duckGainNode.gain.cancelScheduledValues(now);
    this.duckGainNode.gain.setValueAtTime(this.duckGainNode.gain.value, now);
    this.duckGainNode.gain.linearRampToValueAtTime(targetGain, now + DEFAULT_RAMP_MS / 1000);
  }

  stop() {
    this.playToken += 1;
    // 소리가 나기 전(합성 중)에 멈춘 해설과 대기 줄에 남은 해설은 사용자가 듣지 못했다.
    const unplayedList = [
      ...(this.currentEntry && !this.currentSource ? [this.currentEntry] : []), ...this.queue.drain(),
    ];
    try { this.currentSource?.stop(); } catch {  }
    this.currentSource = null;
    this.currentEntry = null;
    for (const entry of unplayedList) this.onDrop({ entry, reason: QUEUE_DROP_REASON_MAP.stopped });
    this.isInserting = false;
    try { this.meetingSource?.disconnect(); } catch {  }
    this.meetingSource = null;
    if (this.audioContext) { this.audioContext.close?.().catch?.(() => {}); this.audioContext = null; }
    this.analyserNode = null;
    this.duckGainNode = null;
    this.narrationGainNode = null;
    this.onStatus('');
  }

  getAnalyser() {
    return this.analyserNode;
  }

  getSicState() {
    return { isInserting: this.isInserting, isCatchingUp: false, playbackRate: 1.0 };
  }
}
