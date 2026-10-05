import { UNKNOWN_CHOICE_INDEX } from './e2e-prompt.mjs';

const CHOICE_COUNT_WITH_UNKNOWN = 5;
const isChoiceNumber = (value) => Number.isInteger(value) && value >= 1 && value <= CHOICE_COUNT_WITH_UNKNOWN;

// 답 번호(1~5)를 읽는다. JSON 이 아니면 "정답: 3" 꼴을 찾고, 그래도 없으면 응답 오류(choiceNumber null)다.
export function parseAnswerText(text) {
  if (typeof text !== 'string' || !text.trim()) return { choiceNumber: null, reason: null };
  const cleaned = text.replace(/```(?:json)?/g, '');
  const jsonMatch = cleaned.match(/\{[^{}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const choiceNumber = Number(parsed.answer);
      if (isChoiceNumber(choiceNumber)) {
        return { choiceNumber, reason: typeof parsed.reason === 'string' ? parsed.reason : null };
      }
    } catch {
      // JSON 이 아니면 아래에서 느슨하게 찾는다.
    }
  }
  const looseMatch = cleaned.match(/(?:answer|정답|답)\s*["']?\s*[:：=]?\s*(\d)/i) || cleaned.trim().match(/^([1-5])(?:\D|$)/);
  const choiceNumber = looseMatch ? Number(looseMatch[1]) : null;
  return { choiceNumber: isChoiceNumber(choiceNumber) ? choiceNumber : null, reason: null };
}

// "알 수 없음"은 오답이다. 응답 오류는 정답률 분모에서 빼고 따로 센다.
export function scoreAnswer({ question, choiceNumber }) {
  if (choiceNumber === null) return { chosenIndex: null, isUnknown: false, isCorrect: false, isResponseError: true };
  const chosenIndex = choiceNumber - 1;
  return {
    chosenIndex,
    isUnknown: chosenIndex === UNKNOWN_CHOICE_INDEX,
    isCorrect: chosenIndex === question.answerIndex,
    isResponseError: false,
  };
}
