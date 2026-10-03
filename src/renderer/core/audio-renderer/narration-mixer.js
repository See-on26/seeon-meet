import { NarrationQueue, shouldInterrupt, QUEUE_DROP_REASON_MAP } from './narration-queue.js';

export const DEFAULT_DUCK_DB = -12;
const DEFAULT_RAMP_MS = 120;
const START_LEAD_SEC = 0.02;
const MEETING_PAN_X = 0.7;
export const NARRATION_PAN_X = -0.7;
const PANNER_DISTANCE_Z = -0.4;

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
  constructor({ onStatus = null, onDrop = null, duckDecibel = DEFAULT_DUCK_DB,
    createAudioContext = () => new AudioContext(), now = () => performance.now() } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onDrop = onDrop || (() => {});
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
    this.queue = new NarrationQueue({ now });
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

  // entry: { wavArrayBuffer, narrationClass, slideLabel, text, dueAt }
  queueCaption(entry) {
    if (!this.audioContext) return;
    this.queue.push(entry);
    if (shouldInterrupt({ currentEntry: this.currentEntry, incomingEntry: entry })) {
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
      const audioBuffer = await this.audioContext.decodeAudioData(entry.wavArrayBuffer);
      if (token !== this.playToken) return;
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.narrationGainNode);
      source.onended = () => { if (token === this.playToken) this.handleNarrationEnded(); };
      this.currentSource = source;
      source.start(this.audioContext.currentTime + START_LEAD_SEC);
      this.onStatus('내레이션 재생 중(회의음 덕킹)…');
    } catch (error) {
      if (token !== this.playToken) return;
      this.onStatus(`내레이션 재생 실패: ${error.message}`);
      this.handleNarrationEnded();
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
    try { this.currentSource?.stop(); } catch {  }
    this.currentSource = null;
    this.currentEntry = null;
    this.queue.clear();
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
