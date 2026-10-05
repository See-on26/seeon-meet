import { UNKNOWN_CHOICE_TEXT } from './eval-types.mjs';
import { UNKNOWN_CHOICE_INDEX } from './e2e-prompt.mjs';

const CHOICE_COUNT_WITH_UNKNOWN = 5;
const UNKNOWN_CHOICE_NUMBER = UNKNOWN_CHOICE_INDEX + 1;
const isChoiceNumber = (value) => Number.isInteger(value) && value >= 1 && value <= CHOICE_COUNT_WITH_UNKNOWN;
const toChoiceNumber = (digitText) => {
  const choiceNumber = Number(digitText);
  return isChoiceNumber(choiceNumber) ? choiceNumber : null;
};

// 답 번호를 어디서 읽었는지: 요청한 JSON(json) 또는 형식을 어긴 글 답(text). 못 읽었으면 null 이다.
export const ANSWER_SOURCE_MAP = { json: 'json', text: 'text' };

const JSON_OBJECT_PATTERN = /\{[^{}]*\}/g;
// JSON answer 가 글이면 번호만 적힌 것("3", "3번", "보기 3번")을 받는다.
const JSON_ANSWER_NUMBER_PATTERN = /^\s*(?:보기\s*)?(\d+)\s*번?\s*\.?\s*$/;
// 번호 붙인 보기 글에서 번호 뒤의 "." 은 뒤에 숫자가 오지 않을 때만 구분자다. 소수 "2.5" 를 "2. 5"(2번 보기 글 5)로 읽지 않는다.
// JSON answer 의 번호 붙인 보기 글: "5. 알 수 없음"·"보기 1번: 재구매율".
const JSON_NUMBERED_CHOICE_PATTERN = /^\s*(?:보기\s*)?(\d+)\s*(?:\.(?!\d)|[):]|번\s*(?:\.(?!\d)|[):])?)\s*(.+)$/s;
// 글 답의 번호 붙인 보기 글은 보기 목록 꼴("5. 알 수 없음"·"1) 재구매율")만 받는다.
const TEXT_NUMBERED_CHOICE_PATTERN = /^(\d+)\s*(?:\.(?!\d)|\))\s*(.+)$/s;

// 글 답 전체가 번호인 꼴: 3 · 3번 · 보기 3번 · 정답은 3번입니다 · 정답: 3 · 답: 3번. 끝의 마침표 하나는 받는다.
// 번호는 (\d+) 로 다 읽은 뒤 범위를 본다(12 를 1 로 읽지 않게).
const REPLY_NUMBER_PATTERN_LIST = [
  /^(?:(?:정답|답)\s*(?:은|는)?\s*[:：]?\s*)?(?:보기\s*)?(\d+)\s*번?\s*(?:입니다|이다)?\s*[.。]?$/,
  /^the\s+answer\s+is\s+(\d+)\s*\.?$/i,
];
// "정답은 …입니다"·"답: …"·"The answer is …" 의 앞뒤 말. 뗀 나머지가 보기 글 그대로인지 본다.
const ANSWER_FRAME_PATTERN_LIST = [
  /^(?:정답|답)\s*(?:은|는)?\s*[:：]?\s*(.+?)\s*(?:입니다|이다)?\s*[.。]?$/s,
  /^the\s+answer\s+is\s+(.+?)\s*\.?$/is,
];
// 숫자 하나에 짧은 단위만 붙은 보기(3 · 3번 · 3회 · 3개 · 3배 · 3%). 번호만 낸 답이 보기 번호인지 그 값인지 가를 수 없다.
const COUNT_LIKE_CHOICE_PATTERN = /^(\d+)\s*(?:[가-힣]{1,2}|%)?$/;
const EDGE_TRIM_PATTERN = /^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』.。!]+$/g;

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
function findChoiceTextNumber({ text, choiceNumberMap, numberedChoicePattern }) {
  const directNumber = choiceNumberMap.get(normalizeChoiceText(text));
  if (directNumber) return directNumber;
  const numberedMatch = text.match(numberedChoicePattern);
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

// JSON answer 칸은 프롬프트대로 보기 번호다. 번호 꼴은 보기 글과 같은 방식으로 다듬은 값(앞뒤 따옴표·괄호, 끝 마침표·느낌표를 뗀다)에서 본다.
// 다듬지 않고 보면 "3!"·'3'·「3」 이 번호로 안 읽히고 보기 글 "3" 으로 읽혀 다른 보기가 된다.
function readJsonAnswerValue({ value, choiceNumberMap }) {
  if (typeof value === 'number') return isChoiceNumber(value) ? value : null;
  if (typeof value !== 'string') return null;
  const numberMatch = normalizeChoiceText(value).match(JSON_ANSWER_NUMBER_PATTERN);
  if (numberMatch) return toChoiceNumber(numberMatch[1]);
  return findChoiceTextNumber({ text: value, choiceNumberMap, numberedChoicePattern: JSON_NUMBERED_CHOICE_PATTERN });
}

// 글 답 전체와, "정답은 …입니다"·"The answer is …" 를 뗀 나머지. 번호 꼴과 보기 글을 같은 후보에서 본다.
function buildReplyCandidateTextList(reply) {
  const framedTextList = ANSWER_FRAME_PATTERN_LIST.map((pattern) => reply.match(pattern)?.[1]).filter(Boolean);
  return [reply, ...framedTextList];
}

// 후보를 보기 글과 같은 방식으로 다듬은 뒤(앞뒤 따옴표·괄호, 끝 마침표·느낌표를 뗀다) 번호 꼴인지 본다.
// 다듬는 방식이 다르면 "3"·「3」·3! 이 번호로는 안 읽히고 보기 글 '3' 으로만 읽혀, 보기 번호와 견주지 못한다.
function findReplyNumber(candidateTextList) {
  for (const candidateText of candidateTextList) {
    const normalizedText = normalizeChoiceText(candidateText);
    const numberMatch = REPLY_NUMBER_PATTERN_LIST.map((pattern) => normalizedText.match(pattern)).find(Boolean);
    if (numberMatch) return toChoiceNumber(numberMatch[1]);
  }
  return null;
}

// 후보 가운데 보기 글 그대로인 것이 있으면 그 보기.
function findReplyChoiceTextNumber({ candidateTextList, choiceNumberMap }) {
  for (const candidateText of candidateTextList) {
    const choiceNumber = findChoiceTextNumber({ text: candidateText, choiceNumberMap, numberedChoicePattern: TEXT_NUMBERED_CHOICE_PATTERN });
    if (choiceNumber) return choiceNumber;
  }
  return null;
}

// 답의 번호 N 과 같은 값을 가진 숫자·횟수 꼴 보기가 N번이 아닌 자리에 있으면, N 이 보기 번호인지 그 값인지 모른다.
function hasCountChoiceElsewhere({ choiceTextList, choiceNumber }) {
  return choiceTextList.some((choiceText, index) => {
    const countMatch = normalizeChoiceText(choiceText).match(COUNT_LIKE_CHOICE_PATTERN);
    return Boolean(countMatch) && Number(countMatch[1]) === choiceNumber && index + 1 !== choiceNumber;
  });
}

// 형식을 어긴 글 답은 답 전체가 번호 꼴이거나 보기 글 그대로일 때만 읽는다. 글 안에서 번호를 찾지 않는다.
// 번호로도 보기 글로도 읽히는데 둘이 다른 보기를 가리키면 못 읽은 것이다.
function readTextAnswer({ reply, choiceTextList, choiceNumberMap }) {
  const candidateTextList = buildReplyCandidateTextList(reply);
  const replyNumber = findReplyNumber(candidateTextList);
  const choiceTextNumber = findReplyChoiceTextNumber({ candidateTextList, choiceNumberMap });
  if (!replyNumber) return choiceTextNumber;
  const isAmbiguous = (choiceTextNumber !== null && choiceTextNumber !== replyNumber)
    || hasCountChoiceElsewhere({ choiceTextList, choiceNumber: replyNumber });
  return isAmbiguous ? null : replyNumber;
}

// 답 번호(1~5)를 읽는다. answer 칸이 있는 JSON 이 있으면 그 값만으로 정하고 글을 다시 뒤지지 않는다.
// JSON 이 없으면 답 전체가 정해진 꼴("3"·"3번"·"정답은 3번입니다"·"The answer is 3")이거나 보기 글 그대로일 때만 읽는다.
// choiceTextList 는 응시자에게 보인 보기(5번 "알 수 없음" 포함)이고, 주면 보기 글로 낸 답도 번호로 바꾼다.
export function parseAnswerText(text, { choiceTextList = [] } = {}) {
  if (typeof text !== 'string' || !text.trim()) return { choiceNumber: null, reason: null, source: null };
  const cleaned = text.replace(/```(?:json)?/g, '');
  const choiceNumberMap = buildChoiceNumberMap(choiceTextList);
  const answerObject = findJsonAnswerObject(cleaned);
  if (answerObject) {
    const choiceNumber = readJsonAnswerValue({ value: answerObject.answer, choiceNumberMap });
    return {
      choiceNumber,
      reason: typeof answerObject.reason === 'string' ? answerObject.reason : null,
      source: choiceNumber === null ? null : ANSWER_SOURCE_MAP.json,
    };
  }
  const choiceNumber = readTextAnswer({ reply: cleaned.trim(), choiceTextList, choiceNumberMap });
  return { choiceNumber, reason: null, source: choiceNumber === null ? null : ANSWER_SOURCE_MAP.text };
}

// "알 수 없음"은 오답이다. 1~5 정수가 아닌 답은 응답 오류로, 정답률 분모에서 빼고 따로 센다.
// source 를 주면 채점 기록에 그대로 실어, 형식을 어긴 글 답에서 읽은 답이 몇 개인지 셀 수 있게 한다.
export function scoreAnswer({ question, choiceNumber, source }) {
  const sourceField = source === undefined ? {} : { source };
  if (!isChoiceNumber(choiceNumber)) {
    return { chosenIndex: null, isUnknown: false, isCorrect: false, isResponseError: true, ...sourceField };
  }
  const chosenIndex = choiceNumber - 1;
  return {
    chosenIndex,
    isUnknown: chosenIndex === UNKNOWN_CHOICE_INDEX,
    isCorrect: chosenIndex === question.answerIndex,
    isResponseError: false,
    ...sourceField,
  };
}
