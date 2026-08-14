export class MeetCaptureSession extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.liveVideo = null;

    this.objectUrl = null;
    this.startedAtMs = 0;
  }

  get isActive() {
    return !!this.stream;
  }

  get videoTimeMs() {
    return this.startedAtMs ? performance.now() - this.startedAtMs : 0;
  }

  detachDirectAudio() {
    if (!this.liveVideo || this.liveVideo.muted) return false;
    this.liveVideo.muted = true;
    return true;
  }

  attachDirectAudio() {
    if (!this.liveVideo || !this.liveVideo.muted) return false;
    this.liveVideo.muted = false;
    return true;
  }

  async start() {
    if (this.stream) throw new Error('이미 캡처 중입니다');
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const videoTrack = this.stream.getVideoTracks()[0];
    if (!videoTrack) { this.stop(); throw new Error('video track이 없습니다'); }

    this.liveVideo = document.createElement('video');
    this.liveVideo.playsInline = true;
    this.liveVideo.muted = true;
    this.liveVideo.srcObject = this.stream;
    await this.liveVideo.play();

    videoTrack.addEventListener('ended', () => this.dispatchEvent(new Event('ended')));
    this.startedAtMs = performance.now();
    return { videoTrack, audioTrack: this.stream.getAudioTracks()[0] };
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    if (this.liveVideo) { this.liveVideo.pause(); this.liveVideo.srcObject = null; }
    this.stream = null;
    this.liveVideo = null;
    this.startedAtMs = 0;
  }
}
