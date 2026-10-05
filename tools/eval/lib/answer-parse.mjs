import { UNKNOWN_CHOICE_TEXT } from './eval-types.mjs';
import { UNKNOWN_CHOICE_INDEX } from './e2e-prompt.mjs';

const CHOICE_COUNT_WITH_UNKNOWN = 5;
const UNKNOWN_CHOICE_NUMBER = UNKNOWN_CHOICE_INDEX + 1;
const isChoiceNumber = (value) => Number.isInteger(value) && value >= 1 && value <= CHOICE_COUNT_WITH_UNKNOWN;
const toChoiceNumber = (digitText) => {
  const choiceNumber = Number(digitText);
  return isChoiceNumber(choiceNumber) ? choiceNumber : null;
};

const JSON_OBJECT_PATTERN = /\{[^{}]*\}/g;
// JSON answer 가 글이면 번호만 적힌 것("3", "3번", "보기 3번")을 받는다.
const JSON_ANSWER_NUMBER_PATTERN = /^\s*(?:보기\s*)?(\d+)\s*번?\s*\.?\s*$/;
// "5. 알 수 없음"·"보기 1번: 재구매율" 처럼 번호를 앞에 붙인 보기 글.
const NUMBERED_CHOICE_PATTERN = /^\s*(?:보기\s*)?(\d+)\s*(?:[.):]|번\s*[.):]?)\s*(.+)$/s;
// "정답: 알 수 없음"·"알 수 없음입니다." 의 앞뒤 말을 떼고 보기 글과 견준다.
const ANSWER_FRAME_PATTERN = /^\s*(?:(?:정답|답)\s*(?:은|는)?\s*[:：]?|(?:the\s+)?answer(?:\s+is)?\s*[:：]?)?\s*(.*?)\s*(?:입니다|이다)?\s*[.。!]?\s*$/is;
const EDGE_TRIM_PATTERN = /^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』.。!]+$/g;

// "정답은 N"·"answer is N" 의 N 뒤에 올 수 있는 것: 번(번째 말고), 닫는 따옴표·괄호, 소수점·천 단위 쉼표가 아닌
// 문장부호, "입니다", 띄어 쓴 여는 괄호(뒤에 붙인 설명), 줄 끝·글 끝. 숫자·소수점·쉼표 뒤 숫자·%·단위(배·개·명·
// percent·times …)가 붙으면 보기 번호가 아니라 답으로 낸 값이므로 읽지 않는다. 값이 보기 글과 같으면 보기 글 쪽에서 읽는다.
const CHOICE_NUMBER_END = String.raw`(?=\s*번(?!\s*째)|["'“”‘’)\]」』]|[;!?。、]|[,，](?!\d)|\.(?!\d)|입니다|\s+[(\[]|[ \t]*(?:\r?\n|$))`;

// JSON 이 아닌 답에서 답 번호를 가리키는 꼴. 번호는 (\d+) 로 다 읽은 뒤 범위를 본다(12 를 1 로 읽지 않게).
// d 플래그로 번호가 끝나는 자리를 받아, 그 뒤에서 아니라고 했는지 본다.
const TEXT_ANSWER_PATTERN_LIST = [
  // 정답은 2번 · 답: "3" · 정답은 보기 2번. "오답"처럼 한글 뒤에 붙은 "답"은 세지 않는다.
  new RegExp(String.raw`(?<![가-힣])(?:정답|답)\s*(?:은|는)?\s*[:：=]?\s*["'“”‘’]?\s*(?:보기\s*)?(\d+)${CHOICE_NUMBER_END}`, 'gd'),
  // 보기 3번이 맞습니다 · 4번이 정답 · 2번입니다
  /(?<!\d)(?:보기\s*)?(\d+)\s*번(?:이\s*(?:맞|정답)|입니다)/gd,
  // The answer is 3 · Answer: 4 · 끊긴 JSON 의 "answer": 3
  new RegExp(String.raw`\banswer\b["']?\s*(?:is\b|[:：=])?\s*(?:(?:choice|option)\s*)?["'(\[]?\s*(\d+)${CHOICE_NUMBER_END}`, 'gid'),
  // 끝을 번호로 맺은 답: …맞으므로 2번
  /(?<!\d)(\d+)\s*번\s*[.!。]?\s*$/gd,
  // 답 전체가 번호: 5 · 2번 · 3번입니다.
  /^\s*(?:보기\s*)?(\d+)\s*번?\s*(?:입니다)?\s*\.?\s*$/gd,
];

// 번호 바로 뒤에서 그 번호를 아니라고 한 말: 3번이 아닙니다 · 3번이 맞지는 않습니다 · 3번이 정답은 아님 · 3번 틀림.
// 아니라고 한 번호는 답이 아니다("3번이 아니라 2번입니다"의 3).
const NEGATED_NUMBER_TAIL_PATTERN = /^\s*번?\s*(?:이|은|는|도)?\s*(?:(?:맞|정답|답)\S*\s*)?(?:아니|아닌|아닙|아님|않|틀|오답)/;
// 맨숫자 보기("3")는 보기 번호와 헷갈리므로 보기 글이 같아도 번호 꼴과 함께 견준다.
const PLAIN_NUMBER_PATTERN = /^\d+$/;

function normalizeChoiceText(text) {
  return String(text).normalize('NFC').replace(/\s+/g, ' ').replace(EDGE_TRIM_PATTERN, '').toLowerCase();
}

// 보기 글 → 번호. 보기를 안 줘도 "알 수 없음"은 늘 5번이다.
function buildChoiceNumberMap(choiceTextList) {
  const choiceNumberMap = new Map();
  choiceTextList.forEach((choiceText, index) => {
    const key = normalizeChoiceText(choiceText);
    if (key && !choiceNumberMap.has(key)) choiceNumberMap.set(key, index + 1);
  });
  const unknownKey = normalizeChoiceText(UNKNOWN_CHOICE_TEXT);
  if (!choiceNumberMap.has(unknownKey)) choiceNumberMap.set(unknownKey, UNKNOWN_CHOICE_NUMBER);
  return choiceNumberMap;
}

// 답이 보기 글 그대로면 그 번호. 앞에 번호를 붙였으면 번호와 글이 같은 보기를 가리켜야 한다.
function findChoiceTextNumber({ text, choiceNumberMap }) {
  const directNumber = choiceNumberMap.get(normalizeChoiceText(text));
  if (directNumber) return directNumber;
  const numberedMatch = text.match(NUMBERED_CHOICE_PATTERN);
  if (!numberedMatch) return null;
  const textNumber = choiceNumberMap.get(normalizeChoiceText(numberedMatch[2]));
  return textNumber && textNumber === Number(numberedMatch[1]) ? textNumber : null;
}

function findJsonAnswerObject(text) {
  for (const [objectText] of text.matchAll(JSON_OBJECT_PATTERN)) {
    try {
      const parsed = JSON.parse(objectText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, 'answer')) return parsed;
    } catch {
      // JSON 이 아닌 중괄호는 건너뛴다.
    }
  }
  return null;
}

function readJsonAnswerValue({ value, choiceNumberMap }) {
  if (typeof value === 'number') return isChoiceNumber(value) ? value : null;
  if (typeof value !== 'string') return null;
  const numberMatch = value.match(JSON_ANSWER_NUMBER_PATTERN);
  if (numberMatch) return toChoiceNumber(numberMatch[1]);
  return findChoiceTextNumber({ text: value, choiceNumberMap });
}

// 답 전체(또는 "정답:"·"입니다" 를 뗀 나머지)가 보기 글과 같으면 그 보기.
function findReplyChoice({ text, choiceNumberMap }) {
  const framedText = text.match(ANSWER_FRAME_PATTERN)?.[1] ?? text;
  for (const candidateText of [text, framedText]) {
    const choiceNumber = findChoiceTextNumber({ text: candidateText, choiceNumberMap });
    if (choiceNumber) return { choiceNumber, isPlainNumber: PLAIN_NUMBER_PATTERN.test(normalizeChoiceText(candidateText)) };
  }
  return null;
}

// 답이 보기 글 그대로면 그 보기다(글 안의 숫자는 따로 세지 않는다). 아니면 답 꼴에서 가리킨 번호를 모두 모은다.
// 아니라고 한 번호는 빼고, 서로 다른 번호가 둘 이상이거나 범위 밖이면 못 읽은 것이다.
function readTextAnswer({ text, choiceNumberMap }) {
  const replyChoice = findReplyChoice({ text, choiceNumberMap });
  if (replyChoice && !replyChoice.isPlainNumber) return replyChoice.choiceNumber;
  const namedNumberSet = new Set(replyChoice ? [replyChoice.choiceNumber] : []);
  for (const pattern of TEXT_ANSWER_PATTERN_LIST) {
    for (const match of text.matchAll(pattern)) {
      const isNegated = NEGATED_NUMBER_TAIL_PATTERN.test(text.slice(match.indices[1][1]));
      if (!isNegated) namedNumberSet.add(Number(match[1]));
    }
  }
  if (namedNumberSet.size !== 1) return null;
  const [choiceNumber] = namedNumberSet;
  return isChoiceNumber(choiceNumber) ? choiceNumber : null;
}

// 답 번호(1~5)를 읽는다. answer 칸이 있는 JSON 이 있으면 그 값만으로 정하고 글을 다시 뒤지지 않는다.
// JSON 이 없으면 답 꼴("정답은 2번"·"보기 3번이 맞습니다"·"The answer is 3"·번호만)과 보기 글 그대로의 답을 읽는다.
// choiceTextList 는 응시자에게 보인 보기(5번 "알 수 없음" 포함)이고, 주면 보기 글로 낸 답도 번호로 바꾼다.
export function parseAnswerText(text, { choiceTextList = [] } = {}) {
  if (typeof text !== 'string' || !text.trim()) return { choiceNumber: null, reason: null };
  const cleaned = text.replace(/```(?:json)?/g, '');
  const choiceNumberMap = buildChoiceNumberMap(choiceTextList);
  const answerObject = findJsonAnswerObject(cleaned);
  if (answerObject) {
    return {
      choiceNumber: readJsonAnswerValue({ value: answerObject.answer, choiceNumberMap }),
      reason: typeof answerObject.reason === 'string' ? answerObject.reason : null,
    };
  }
  return { choiceNumber: readTextAnswer({ text: cleaned, choiceNumberMap }), reason: null };
}

// "알 수 없음"은 오답이다. 1~5 정수가 아닌 답은 응답 오류로, 정답률 분모에서 빼고 따로 센다.
export function scoreAnswer({ question, choiceNumber }) {
  if (!isChoiceNumber(choiceNumber)) return { chosenIndex: null, isUnknown: false, isCorrect: false, isResponseError: true };
  const chosenIndex = choiceNumber - 1;
  return {
    chosenIndex,
    isUnknown: chosenIndex === UNKNOWN_CHOICE_INDEX,
    isCorrect: chosenIndex === question.answerIndex,
    isResponseError: false,
  };
}
