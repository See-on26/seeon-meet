// 이 임계는 "동일성 판정"이 아니라 "명백히 같은 프레임 거르기"다. 실측(2026-08-09)에서 같은
// 슬라이드가 0.100까지, 다른 슬라이드가 0.102부터 나와 두 분포가 겹쳤다 — 이미지로는 못 가른다.
// 반복 후보를 싸게 걸러내는 선까지만 쓰고(같은 슬라이드 다수가 0.06 이하), 최종 동일성은
// 주제 텍스트로 판정한다(orchestrator/slide-topic-registry).
const DEFAULT_MATCH_THRESHOLD = 0.06;

function computeNorm(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  return Math.sqrt(sum);
}

export function computeCosineDistance(vectorA, vectorB) {
  if (!vectorA || !vectorB || vectorA.length !== vectorB.length) return 1;
  const normA = computeNorm(vectorA);
  const normB = computeNorm(vectorB);
  if (normA === 0 || normB === 0) return 1;
  let dot = 0;
  for (let i = 0; i < vectorA.length; i += 1) dot += vectorA[i] * vectorB[i];
  return 1 - dot / (normA * normB);
}

export class SlideEmbeddingRegistry {
  constructor({ matchThreshold = DEFAULT_MATCH_THRESHOLD } = {}) {
    this.matchThreshold = matchThreshold;
    this.reset();
  }

  reset() {
    this.slideList = [];
    this.committedSlide = null;
    this.nextMajor = 1;
  }

  handleCandidate({ embedding, matchThreshold = this.matchThreshold }) {
    if (!this.committedSlide) return this._registerNew(embedding);
    const previousCommitted = this.committedSlide;
    const { slide, distance } = this._findNearest(embedding);
    if (slide && distance <= matchThreshold) {
      this.committedSlide = slide;

      const isSameSlide = slide === previousCommitted;
      return {
        label: String(slide.major),
        isNew: false,
        isRevisit: !isSameSlide,
        isSameSlide,
        distance,
      };
    }
    return this._registerNew(embedding, distance);
  }

  _registerNew(embedding, distance = 1) {
    const slide = { major: this.nextMajor, embedding, minorCount: 0 };
    this.nextMajor += 1;
    this.slideList.push(slide);
    this.committedSlide = slide;
    return { label: String(slide.major), isNew: true, isRevisit: false, isSameSlide: false, distance };
  }

  handleAnnotation() {
    if (!this.committedSlide) return null;
    this.committedSlide.minorCount += 1;
    return {
      major: this.committedSlide.major,
      minor: this.committedSlide.minorCount,
      label: `${this.committedSlide.major}-${this.committedSlide.minorCount}`,
    };
  }

  currentLabel() {
    return this.committedSlide ? String(this.committedSlide.major) : null;
  }

  _findNearest(embedding) {
    let best = null;
    let bestDistance = Infinity;
    for (const slide of this.slideList) {
      const distance = computeCosineDistance(slide.embedding, embedding);
      if (distance < bestDistance) { bestDistance = distance; best = slide; }
    }
    return { slide: best, distance: best ? bestDistance : 1 };
  }
}
