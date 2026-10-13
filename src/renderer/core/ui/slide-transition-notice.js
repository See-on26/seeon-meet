// 전환 순간에는 슬라이드인지 아직 모른다(OS 화면일 수도 있다). 화면 비교 순번은 OS 화면까지 세므로 보이지 않는다.
export function buildSlideTransitionNotice({ isRevisit }) {
  return isRevisit ? '이전 화면으로 복귀 — 고지 생성 중…' : '화면 전환 — 화면 고지 생성 중…';
}
