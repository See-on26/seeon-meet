// ASR 은 말을 몇 초 단위 조각으로 잘라 전사하고, 트리거는 조각 글자마다 돈다. 자르는 자리가 어절 안이면
// ("크게 늘 | 었습니다") 앞뒤 조각 어느 쪽에서도 후보가 안 나온다. 앞 조각이 문장 중간에서 끝났고 바로 이어지는
// 조각이면 앞 조각 끝 몇 어절을 붙여 한 번 더 돌리고, 그때만 생긴 후보를 이 조각의 후보로 붙인다.
// 화면 쪽은 문장이 안 끝난 앞 조각을 발화 앞에 이어 판단 LLM 에 보내므로, 판단은 이어진 문장을 본다.
const BOUNDARY_MAX_GAP_MS = 1000;
const BOUNDARY_TAIL_WORD_COUNT = 3;
const SENTENCE_END_PATTERN = /[.?!。？！…]["'”’)\]]*\s*$/;

const candidateKeyOf = (candidate) => `${candidate.type}|${candidate.phrase}`;

function createBoundaryTrigger({ detect, maxGapMs = BOUNDARY_MAX_GAP_MS, tailWordCount = BOUNDARY_TAIL_WORD_COUNT }) {
  let previous = null;

  function isJoinable({ startTs }) {
    if (!previous || SENTENCE_END_PATTERN.test(previous.text)) return false;
    if (!Number.isFinite(startTs) || !Number.isFinite(previous.endTs)) return false;
    const gapMs = startTs - previous.endTs;
    return gapMs >= -maxGapMs && gapMs <= maxGapMs;
  }

  // 경계 후보는 앞 꼬리에서 시작해 꼬리 끝에 닿거나 넘어가는 구만이다. 꼬리 안에서 끝난 구는 앞 조각이 이미 봤다
  // (꼬리를 몇 어절로 자르면 "크게 늘었습니다"가 "늘었습니다"처럼 모양만 바뀐다). 이어 붙인 글에서 앞·이 조각의
  // 후보와 자리가 겹쳐도 이미 잡은 것으로 본다("더 높" ↔ "높 는 겁", "늘었습니다" ↔ "크게 늘었습니다").
  function detectAcrossBoundary({ text, ownCandidateList }) {
    const tail = previous.text.split(/\s+/).filter(Boolean).slice(-tailWordCount).join(' ');
    const tailStartInPrevious = previous.text.lastIndexOf(tail);
    const toRange = (candidate, shift) => (Number.isFinite(candidate.start) && Number.isFinite(candidate.end)
      ? { start: candidate.start + shift, end: candidate.end + shift } : null);
    const knownRangeList = [
      ...(tailStartInPrevious >= 0 ? previous.candidateList.map((candidate) => toRange(candidate, -tailStartInPrevious)) : []),
      ...ownCandidateList.map((candidate) => toRange(candidate, tail.length + 1)),
    ].filter(Boolean);
    const knownKeySet = new Set([...previous.candidateList, ...ownCandidateList].map(candidateKeyOf));
    const isKnown = (candidate) => knownKeySet.has(candidateKeyOf(candidate))
      || knownRangeList.some((range) => candidate.end > range.start && candidate.start < range.end);
    return detect({ text: `${tail} ${text}` }).candidateList
      .filter((candidate) => Number.isFinite(candidate.start) && Number.isFinite(candidate.end))
      .filter((candidate) => candidate.start < tail.length && candidate.end >= tail.length)
      .filter((candidate) => !isKnown(candidate))
      .map((candidate) => ({ ...candidate, start: 0, end: 0, isBoundary: true }));
  }

  // startTs·endTs: 이 조각 녹음 시작·끝 시각. 조각 순서가 뒤바뀌어 오면 이어 보지 않고 앞 조각도 바꾸지 않는다.
  function detectChunk({ text, startTs, endTs }) {
    const own = detect({ text });
    const ownCandidateList = own.candidateList || [];
    const boundaryList = isJoinable({ startTs }) ? detectAcrossBoundary({ text, ownCandidateList }) : [];
    if (!previous || !Number.isFinite(previous.endTs) || !(endTs < previous.endTs)) {
      previous = { text: String(text || '').trim(), endTs, candidateList: ownCandidateList };
    }
    return { ...own, candidateList: [...boundaryList, ...ownCandidateList], boundaryCount: boundaryList.length };
  }

  return { detect: detectChunk, reset: () => { previous = null; } };
}

module.exports = { createBoundaryTrigger, BOUNDARY_MAX_GAP_MS, BOUNDARY_TAIL_WORD_COUNT };
