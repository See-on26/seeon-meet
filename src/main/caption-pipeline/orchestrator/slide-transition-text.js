const { CAPTION_LANGUAGE_MAP, DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');

// 화면 전환 해설의 머리말. PPT 만 "슬라이드 N:" 이고, 웹·문서·OS 화면은 번호 없이 "페이지:" 다.
// 문서·웹 같은 화면에 순번을 붙이면 슬라이드 번호와 섞인다. 화면마다 매기는 내부 번호(slideLabel)는 들려주지 않는다.
const PAGE_PREFIX = '페이지';

// 캡션 언어별 머리말. 영어 캡션은 "Slide N:"·"Page:"·"Previous page:" 로 읽는다.
const TRANSITION_TEXT_MAP = {
  [CAPTION_LANGUAGE_MAP.ko]: {
    page: (text) => `${PAGE_PREFIX}: ${text}`,
    slide: (number, text) => `슬라이드 ${number}: ${text}`,
    previousPage: (text) => `이전 ${PAGE_PREFIX}: ${text}`,
  },
  [CAPTION_LANGUAGE_MAP.en]: {
    page: (text) => `Page: ${text}`,
    slide: (number, text) => `Slide ${number}: ${text}`,
    previousPage: (text) => `Previous page: ${text}`,
  },
};

function readTransitionText(language) {
  return TRANSITION_TEXT_MAP[language] || TRANSITION_TEXT_MAP[DEFAULT_CAPTION_LANGUAGE];
}

function buildTransitionNarration({ isSlide, displayNumber, narration, language = DEFAULT_CAPTION_LANGUAGE }) {
  const textMap = readTransitionText(language);
  if (!isSlide) return textMap.page(narration);
  return displayNumber ? textMap.slide(displayNumber, narration) : narration;
}

// 이미 본 화면으로 돌아오면 화면 유형·번호와 상관없이 "이전 페이지: 주제" 로 짧게 알린다.
function buildRevisitNarration({ topic, language = DEFAULT_CAPTION_LANGUAGE }) {
  return readTransitionText(language).previousPage(topic);
}

// 사용자가 듣는 번호. PPT 만 슬라이드 순서(화면에 슬라이드 번호가 보이면 그 번호)를 쓴다.
// 문서 화면에 보이는 쪽 번호는 "슬라이드 N" 으로 들려주지 않으므로 질문·요약에서도 번호로 쓰지 않는다.
function resolveHeardSlideNumber({ isSlide, registryNumber, visiblePageNumber }) {
  if (!isSlide) return null;
  return registryNumber || visiblePageNumber || null;
}

module.exports = { buildTransitionNarration, buildRevisitNarration, resolveHeardSlideNumber, PAGE_PREFIX };
