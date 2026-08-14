
const SEEK_TOLERANCE_MS = 250;

export class FileDelaySource {
  constructor({ sourceUrl, getLiveVideo, targetDelayMs, createElement = () => document.createElement('video') }) {
    this.sourceUrl = sourceUrl;
    this.getLiveVideo = getLiveVideo;
    this.targetDelayMs = targetDelayMs;
    this.createElement = createElement;
    this.element = null;
    this.startTimeMs = 0;
    this.isMetadataReady = false;
  }

  start({ fromTimeMs = null } = {}) {
    const liveVideo = this.getLiveVideo();
    this.element = this.createElement();
    this.element.playsInline = true;
    this.element.src = this.sourceUrl;
    const liveTimeMs = liveVideo ? liveVideo.currentTime * 1000 : 0;
    this.startTimeMs = Number.isFinite(fromTimeMs)
      ? Math.max(0, fromTimeMs) : Math.max(0, liveTimeMs - this.targetDelayMs);

    this.element.addEventListener?.('loadedmetadata', () => {
      if (Math.abs(this.element.currentTime * 1000 - this.startTimeMs) > SEEK_TOLERANCE_MS) {
        this.element.currentTime = this.startTimeMs / 1000;
      }
      this.isMetadataReady = true;
    }, { once: true });
    this.element.currentTime = this.startTimeMs / 1000;
    return this.element;
  }

  getElement() {
    return this.element;
  }

  getLiveTimeMs() {
    const liveVideo = this.getLiveVideo();
    return liveVideo ? liveVideo.currentTime * 1000 : 0;
  }

  getPlayheadMs() {
    if (!this.element) return 0;
    if (!this.isMetadataReady && this.element.readyState !== undefined && this.element.readyState < 1) {
      return this.startTimeMs;
    }
    return this.element.currentTime * 1000;
  }

  isReady() {
    if (!this.element) return false;
    return (this.element.readyState ?? 1) >= 1;
  }

  getDriftMs() {
    return 0;
  }

  stop() {
    this.element?.pause();
    this.element = null;
    this.isMetadataReady = false;
  }
}
