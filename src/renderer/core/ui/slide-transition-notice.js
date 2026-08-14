import { defaultUiText } from '../i18n/ui-text.js';

// 전환 순간에는 슬라이드인지 아직 모른다(OS 화면일 수도 있다). 화면 비교 순번은 OS 화면까지 세므로 보이지 않는다.
// 페이지 전환 안내를 꺼 두면 그 고지는 재생되지 않으므로 "생성 중" 안내도 띄우지 않는다(null).
export function buildSlideTransitionNotice({ isRevisit, isPageTransitionOn = true, t = defaultUiText }) {
  if (!isPageTransitionOn) return null;
  return t(isRevisit ? 'notice.slideRevisit' : 'notice.slideTransition');
}
