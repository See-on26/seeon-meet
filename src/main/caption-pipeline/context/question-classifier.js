const QUESTION_ROUTE_MAP = {
  currentScreen: 'current_screen',
  pastSlide: 'past_slide',
  speaker: 'speaker',
  speakerNow: 'speaker_now',
  narrationReplay: 'narration_replay',
  meetingFlow: 'meeting_flow',
  none: 'none',
};

const SLIDE_NUMBER_PATTERN_LIST = [
  /(\d+)\s*(?:번째|번)?\s*(?:슬라이드|페이지|장)/,
  /(?:슬라이드|페이지)\s*(\d+)/,
];

const SPEAKER_NOW_PATTERN = /(?:지금|현재)[^?？]*?(?:누가|누구)/;

// 규칙으로 확실히 가를 수 있는 질문만 고른다. 나머지(null)는 LLM 라우터가 색인을 보고 정한다.
// spokenNumber 는 사용자가 말한 번호 그대로다. 저장소 번호로 바꾸는 것은 저장소(resolveSlideNumber)가 한다.
function classifyQuestion(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  for (const pattern of SLIDE_NUMBER_PATTERN_LIST) {
    const match = trimmed.match(pattern);
    if (match) return { route: QUESTION_ROUTE_MAP.pastSlide, spokenNumber: Number(match[1]) };
  }
  if (SPEAKER_NOW_PATTERN.test(trimmed)) return { route: QUESTION_ROUTE_MAP.speakerNow, spokenNumber: null };
  return null;
}

module.exports = { classifyQuestion, QUESTION_ROUTE_MAP };
