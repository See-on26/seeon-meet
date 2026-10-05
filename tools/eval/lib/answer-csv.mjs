// 문항×조건 한 줄(긴 형식). 팀이 LLM·사람 응답을 이어 붙여 혼합효과 로지스틱 모형으로 따로 분석한다.
// 사람 응답도 같은 칸(evaluator=사람, participantId)으로 적으면 그대로 합칠 수 있다.
export const ANSWER_CSV_COLUMN_LIST = [
  'evaluator', 'participantId', 'model', 'repeat', 'videoId', 'domain', 'questionId', 'category', 'subcategory',
  'condition', 'chosenIndex', 'isUnknown', 'isCorrect', 'isResponseError',
];

export const LLM_EVALUATOR = 'LLM';

function escapeCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const toFlag = (value) => (value ? 1 : 0);

// chosenIndex 는 보여 준 보기 5개 중 0부터 센 번호(4 = 알 수 없음). 응답 오류면 chosenIndex·isUnknown·isCorrect 를 비운다.
export function toAnswerCsvRow({ answer, modelId }) {
  return {
    evaluator: LLM_EVALUATOR,
    participantId: '',
    model: modelId,
    repeat: answer.repeatIndex + 1,
    videoId: answer.videoId,
    domain: answer.domain,
    questionId: answer.questionId,
    category: answer.category,
    subcategory: answer.subcategory,
    condition: answer.condition,
    chosenIndex: answer.isResponseError ? '' : answer.chosenIndex,
    isUnknown: answer.isResponseError ? '' : toFlag(answer.isUnknown),
    isCorrect: answer.isResponseError ? '' : toFlag(answer.isCorrect),
    isResponseError: toFlag(answer.isResponseError),
  };
}

// BOM 없이 UTF-8, 줄 끝 \n.
export function buildAnswerCsv({ answerList, modelId }) {
  const lineList = [ANSWER_CSV_COLUMN_LIST.join(',')];
  for (const answer of answerList) {
    const row = toAnswerCsvRow({ answer, modelId });
    lineList.push(ANSWER_CSV_COLUMN_LIST.map((column) => escapeCsvCell(row[column])).join(','));
  }
  return `${lineList.join('\n')}\n`;
}
