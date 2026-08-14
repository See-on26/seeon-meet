// 캡션 언어: 사용자에게 들리는 말(자동 AD·질문 답·고정 문구·TTS·회의 요약)과 앱 화면 글자의 언어.
// 렌더러 설정(caption-language-store.js)에서 고르고 캡처를 시작할 때 세션마다 넘어온다. 회의 받아쓰기 언어(자동)와는 따로다.
const CAPTION_LANGUAGE_MAP = { ko: 'ko', en: 'en' };
const CAPTION_LANGUAGE_LIST = Object.values(CAPTION_LANGUAGE_MAP);
const DEFAULT_CAPTION_LANGUAGE = CAPTION_LANGUAGE_MAP.ko;

function isCaptionLanguage(language) {
  return CAPTION_LANGUAGE_LIST.includes(language);
}

// 값을 보내지 않는 옛 호출이면 조용히 한국어로, 허용값이 아니면 경고하고 한국어로 둔다.
function resolveCaptionLanguage(language) {
  if (language === undefined || language === null) return DEFAULT_CAPTION_LANGUAGE;
  if (isCaptionLanguage(language)) return language;
  console.warn(`[pipeline] 캡션 언어 "${language}" 은 지원하지 않습니다 — ${DEFAULT_CAPTION_LANGUAGE} 로 씁니다 (허용: ${CAPTION_LANGUAGE_LIST.join('·')})`);
  return DEFAULT_CAPTION_LANGUAGE;
}

module.exports = {
  CAPTION_LANGUAGE_MAP, CAPTION_LANGUAGE_LIST, DEFAULT_CAPTION_LANGUAGE, isCaptionLanguage, resolveCaptionLanguage,
};
