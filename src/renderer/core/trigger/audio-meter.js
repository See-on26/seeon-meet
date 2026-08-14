const METER_WIDTH_PX = 160;
const METER_HEIGHT_PX = 14;
const METER_LOUD_LEVEL = 0.35;

export class AudioMeter {
  constructor(canvas = null) {
    this.context = canvas ? canvas.getContext('2d') : null;
    this.analyser = null;
    this.audioContext = null;
    this.isRunning = false;
    this.level = 0;
  }

  getLevel() {
    return this.level;
  }

  start(stream) {
    if (!stream.getAudioTracks().length) return;
    this.audioContext = new AudioContext();
    const sourceNode = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    sourceNode.connect(this.analyser);
    this.isRunning = true;
    this._sample();
  }

  stop() {
    this.isRunning = false;
    this.analyser = null;
    this.level = 0;
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
    this.context?.clearRect(0, 0, METER_WIDTH_PX, METER_HEIGHT_PX);
  }

  _sample() {
    if (!this.isRunning || !this.analyser) return;
    const sampleData = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(sampleData);
    let squareSum = 0;
    for (const sample of sampleData) squareSum += (sample - 128) ** 2;
    this.level = Math.sqrt(squareSum / sampleData.length) / 128;
    if (this.context) {
      this.context.clearRect(0, 0, METER_WIDTH_PX, METER_HEIGHT_PX);
      this.context.fillStyle = this.level > METER_LOUD_LEVEL ? '#e0a545' : '#3ecf6f';
      this.context.fillRect(0, 0, Math.min(METER_WIDTH_PX, this.level * 500), METER_HEIGHT_PX);
    }
    requestAnimationFrame(() => this._sample());
  }
}
