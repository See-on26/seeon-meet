import { UNKNOWN_CHOICE_TEXT } from './eval-types.mjs';

export const INSTRUCTION_KIND_MAP = { eval: 'eval', filter: 'filter' };
export const UNKNOWN_CHOICE_INDEX = 4;

const ANSWER_FORMAT_LINE = '답은 JSON 한 줄로만 낸다: {"answer": 보기 번호(1~5), "reason": "근거 한 문장"}';

// 평가 답변은 "제공된 자료만 근거로 답하라"를 넣는다(회의록 3.2.3). 필터 단계는 이 지시 없이 묻는다.
export const SYSTEM_PROMPT_MAP = {
  [INSTRUCTION_KIND_MAP.eval]: [
    '너는 발표 영상 이해도 문항에 답하는 응시자다.',
    '제공된 자료만 근거로 답하라. 자료로 알 수 없으면 "알 수 없음"을 고른다.',
    ANSWER_FORMAT_LINE,
  ].join('\n'),
  [INSTRUCTION_KIND_MAP.filter]: ['너는 객관식 문항에 답하는 응시자다.', ANSWER_FORMAT_LINE].join('\n'),
};

// 4지선다 뒤에 "알 수 없음"을 5번째 보기로 붙인다.
export function buildChoiceList({ question }) {
  return [...question.choiceList, UNKNOWN_CHOICE_TEXT];
}

export function buildQuestionText({ question }) {
  const choiceLineList = buildChoiceList({ question }).map((choice, index) => `${index + 1}. ${choice}`);
  return ['[문항]', question.question, '', '[보기]', ...choiceLineList].join('\n');
}

export function buildAnswerRequest({ instructionKind, materialBlockList, question }) {
  return {
    systemPrompt: SYSTEM_PROMPT_MAP[instructionKind],
    messageList: [{ role: 'user', content: [...materialBlockList, { text: buildQuestionText({ question }) }] }],
  };
}
