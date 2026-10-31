const { formatElapsed } = require('./clock-format');
const { keepNewestWithinChars } = require('./newest-within-chars');

// 질문 갈래 나누기와 답 만들기에 넘기는 이번 회의의 질문·답 기록. 웹 LLM 대화처럼 앞 대화를 이어 보게 한다.
// 질문·답 하나가 100자 안팎이라 8,000자면 80개 남짓이다. 넘으면 가장 오래된 질문부터 뺀다.
const QA_HISTORY_MAX_CHARS = 8000;
// 프리셋 명령(무슨 자료야? 등)의 답. 질문 갈래를 거치지 않으므로 기록에만 이 이름으로 남긴다.
const PRESET_QA_ROUTE = 'preset_command';

function formatTargetSlide({ qa }) {
  return (qa.slideMajorList || []).join(', ') || '없음';
}

function formatQaLine({ qa, startedAt, isSlideShown, isTimeShown }) {
  const timeText = isTimeShown ? `[${formatElapsed({ ts: qa.ts, startedAt })}] ` : '';
  const slideText = isSlideShown ? ` / 대상 슬라이드: ${formatTargetSlide({ qa })}` : '';
  return `${timeText}질문: ${qa.question} / 답: ${qa.answer}${slideText}`;
}

// isSlideShown: 라우터는 되묻기에 앞 질문의 대상 슬라이드 id 를 그대로 쓰므로 함께 적는다. 답 만들기에는 내부 id 를 보이지 않는다.
function formatQaHistory({ qaList, startedAt, isSlideShown = false, isTimeShown = true, maxChars = QA_HISTORY_MAX_CHARS }) {
  const lineList = qaList.map((qa) => formatQaLine({ qa, startedAt, isSlideShown, isTimeShown }));
  return keepNewestWithinChars({ lineList, maxChars }).join('\n');
}

function buildPresetQa({ ts, command, questionLabel, text, currentSlideMajor }) {
  const hasSlide = currentSlideMajor !== null && currentSlideMajor !== undefined;
  return {
    ts, question: questionLabel || command, answer: text, route: PRESET_QA_ROUTE,
    slideMajorList: hasSlide ? [currentSlideMajor] : [],
  };
}

module.exports = { formatQaHistory, formatTargetSlide, buildPresetQa, QA_HISTORY_MAX_CHARS, PRESET_QA_ROUTE };
