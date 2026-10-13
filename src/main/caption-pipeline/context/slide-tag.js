// 질문 답 프롬프트에서 화면을 부르는 꼬리표. 사용자가 들은 번호가 있을 때만 "슬라이드 N" 이라 부른다.
// 내부 번호(major)는 OS·문서 화면까지 세므로 번호처럼 보이면 답이 사용자가 듣지 못한 번호를 말한다.
const UNNUMBERED_SCREEN_TAG = '번호 없는 화면';

function formatHeardSlideTag({ displayNumber }) {
  return Number.isFinite(displayNumber) && displayNumber > 0 ? `슬라이드 ${displayNumber}` : UNNUMBERED_SCREEN_TAG;
}

module.exports = { formatHeardSlideTag, UNNUMBERED_SCREEN_TAG };
