// 질문 답은 15초 미만(TTS 어절당 약 0.45초), 기본 1~2문장이다. 짧게 답할 수 있는 질문은 2~5초 분량으로 끝낸다.
// 규칙·조건을 묻는 질문은 짧게 줄이면 조건 절이 빠져 뜻이 바뀌므로 2문장까지 쓰게 한다.
function buildAnswerLengthRule({ minWordCount, maxWordCount, maxChars = null }) {
  const charText = Number.isFinite(maxChars) ? ` (최대 ${maxChars}자)` : '';
  return `${minWordCount}~${maxWordCount}어절, 1~2문장으로 답한다${charText}. `
    + '예/아니오·값 하나·이름 하나로 답할 수 있는 질문은 한 문장으로 짧게 답한다. '
    + '규칙·조건·절차·정의를 묻는 질문은 짧게 줄이지 않는다 — 조건과 결과를 모두 담아 2문장까지 쓴다.';
}

module.exports = { buildAnswerLengthRule };
