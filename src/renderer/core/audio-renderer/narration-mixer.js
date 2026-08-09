const DEFAULT_DUCK_DB = -12;
const DEFAULT_RAMP_MS = 120;
const MEETING_PAN_X = 0.7;
const NARRATION_PAN_X = -0.7;
const PANNER_DISTANCE_Z = -0.4;

export function computeGainFromDecibel({ decibel }) {
  return 10 ** (decibel / 20);
}

export class NarrationMixer {
  constructor({ onStatus = null, duckDecibel = DEFAULT_DUCK_DB,
    createAudioContext = () => new AudioContext() } = {}) {
    this.onStatus = onStatus || (() => {});
    this.duckDecibel = duckDecibel;
    this.createAudioContext = createAudioContext;
    this.audioContext = null;
    this.analyserNode = null;
    this.duckGainNode = null;
    this.narrationGainNode = null;
    this.meetingSource = null;
    this.currentSource = null;
    this.queueList = [];
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
    const panner = this.audioContext.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    panner.positionX.value = positionX;
    panner.positionY.value = 0;
    panner.positionZ.value = PANNER_DISTANCE_Z;
    return panner;
  }

  queueCaption(wavArrayBuffer) {
    if (!this.audioContext) return;
    this.queueList.push(wavArrayBuffer);
    if (!this.isInserting) this.beginNext();
  }

  async beginNext() {
    const buffer = this.queueList[0];
    if (!buffer) return;
    if (!this.isInserting) {
      this.isInserting = true;
      this.duck({ isDucked: true });
      if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => {});
    }
    try {
      const audioBuffer = await this.audioContext.decodeAudioData(buffer);
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.narrationGainNode);
      source.onended = () => this.handleNarrationEnded();
      this.currentSource = source;
      source.start();
      this.onStatus('나레이션 재생 중(회의음 덕킹)…');
    } catch (error) {
      this.onStatus(`나레이션 재생 실패: ${error.message}`);
      this.handleNarrationEnded();
    }
  }

  handleNarrationEnded() {
    this.queueList.shift();
    this.currentSource = null;
    if (this.queueList.length) { this.beginNext(); return; }
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
    try { this.currentSource?.stop(); } catch {  }
    this.currentSource = null;
    this.queueList = [];
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

  getScuState() {
    return { isInserting: this.isInserting, isCatchingUp: false, playbackRate: 1.0 };
  }
}
