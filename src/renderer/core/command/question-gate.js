// 질문을 지금 받을 수 없으면 그 까닭을 알리는 문구 키, 받을 수 있으면 null.
// 일시정지하면 캡처·해설을 바로 멈추므로 그사이 질문(화면을 찍어 GPU 로 보내는 일)도 받지 않는다.
export function readQuestionBlockedTextKey({ isCapturing, isPaused }) {
  if (!isCapturing) return 'question.notCapturing';
  if (isPaused) return 'question.paused';
  return null;
}
