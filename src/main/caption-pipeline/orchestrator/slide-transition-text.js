// 화면 전환 해설의 머리말. PPT 만 "슬라이드 N:" 이고, 웹·문서·OS 화면은 번호 없이 "페이지:" 다.
// 문서·웹 같은 화면에 순번을 붙이면 슬라이드 번호와 섞인다. 화면마다 매기는 내부 번호(slideLabel)는 들려주지 않는다.
const PAGE_PREFIX = '페이지';

function buildTransitionNarration({ isSlide, displayNumber, narration }) {
  if (!isSlide) return `${PAGE_PREFIX}: ${narration}`;
  return displayNumber ? `슬라이드 ${displayNumber}: ${narration}` : narration;
}

function buildRevisitNarration({ isSlide, displayNumber, topic }) {
  if (!isSlide) return `이전 ${PAGE_PREFIX}: ${topic}`;
  return displayNumber ? `이전 슬라이드 ${displayNumber}: ${topic}` : `이전 화면: ${topic}`;
}

// 사용자가 듣는 번호. PPT 만 슬라이드 순서(화면에 슬라이드 번호가 보이면 그 번호)를 쓴다.
// 문서 화면에 보이는 쪽 번호는 "슬라이드 N" 으로 들려주지 않으므로 질문·요약에서도 번호로 쓰지 않는다.
function resolveHeardSlideNumber({ isSlide, registryNumber, visiblePageNumber }) {
  if (!isSlide) return null;
  return registryNumber || visiblePageNumber || null;
}

module.exports = { buildTransitionNarration, buildRevisitNarration, resolveHeardSlideNumber, PAGE_PREFIX };
