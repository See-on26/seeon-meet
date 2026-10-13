// 화면 전환 해설의 머리말. 번호는 슬라이드에만 붙인다. 문서·웹 같은 화면에 순번을 붙이면 슬라이드 번호와 섞인다.
function buildTransitionNarration({ isSlide, displayNumber, narration }) {
  return isSlide && displayNumber ? `슬라이드 ${displayNumber}: ${narration}` : narration;
}

function buildRevisitNarration({ isSlide, displayNumber, topic }) {
  return isSlide && displayNumber ? `이전 슬라이드 ${displayNumber}: ${topic}` : `이전 화면: ${topic}`;
}

module.exports = { buildTransitionNarration, buildRevisitNarration };
