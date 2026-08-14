const { USER_COMMAND_MAP } = require('../contracts/narration-types');
const { GROUNDING_NONE_TOKEN, computeMaxChars } = require('../agents/shared/caption-parser');

const DEFAULT_COMMAND_MIN_WORD_COUNT = 6;
const DEFAULT_COMMAND_MAX_WORD_COUNT = 25;

const USER_COMMAND_RULE_MAP = {
  [USER_COMMAND_MAP.screenMaterial]: [
    '질문: 지금 공유화면에 어떤 자료가 공유되고 있는가?',
    '자료의 형태를 밝혀라 — 문서 / ppt 발표자료 / 엑셀 / 웹사이트(글) / 웹사이트(영상) / 이미지 등.',
    '형태와 함께 무엇에 대한 자료인지(제목·주제)를 한 문장으로 답한다.',
  ],
  [USER_COMMAND_MAP.pageSummary]: [
    '질문: 이 페이지에 있는 자료를 모두 정리해 말해달라.',
    '화면에 있는 시각자료를 **빠짐없이** 훑어 종류와 주제를 나열하라 (표·그래프·사진·다이어그램·본문 등).',
    '로고·배경·장식 요소는 제외한다. 위에서 아래, 왼쪽에서 오른쪽 순서로 정리한다.',
  ],
  [USER_COMMAND_MAP.graphAxis]: [
    '질문: 그래프의 축을 설명해달라.',
    '화면의 그래프에서 **가로축과 세로축이 각각 무엇인지, 단위와 범위는 어떻게 되는지** 밝혀라.',
    `화면에 그래프가 없으면 정확히 "${GROUNDING_NONE_TOKEN}"만 출력한다.`,
  ],
};

function buildCommandPrompt({ command,
  minWordCount = DEFAULT_COMMAND_MIN_WORD_COUNT,
  maxWordCount = DEFAULT_COMMAND_MAX_WORD_COUNT, maxChars = null }) {
  const ruleList = USER_COMMAND_RULE_MAP[command];
  if (!ruleList) return '';
  const effectiveMaxChars = Number.isFinite(maxChars) ? maxChars : computeMaxChars({ maxWordCount });
  return [
    '이 이미지는 회의에서 공유 중인 화면이다.',
    '청자는 시각장애인이며, **직접 물어본 질문**에 답하는 중이다.',
    '',
    ...ruleList,
    '',
    '규칙:',
    '(1) 화면에 실제로 보이는 것만 쓴다. 지어내지 않는다.',
    `(2) ${minWordCount}~${maxWordCount}어절로 답한다 (최대 ${effectiveMaxChars}자).`,
    '(3) 머리말·인사말 없이 답만 출력한다.',
    '(4) 이미 안내했던 내용이라도 **다시 답한다** — 사용자가 직접 물었기 때문이다.',
  ].join('\n');
}

// 자유 자연어 질문(프리셋 커맨드가 아닌 것) — 화면 + 최근 발화 맥락으로 답한다.
// PDF 3.1.2⑧의 "심화 질의응답 에이전트" 경로. 전용 생성기를 새로 만들지 않고 이 프롬프트를 쓴다.
function buildFreeQuestionPrompt({ questionText,
  minWordCount = DEFAULT_COMMAND_MIN_WORD_COUNT,
  maxWordCount = DEFAULT_COMMAND_MAX_WORD_COUNT, maxChars = null, recentTranscript = '' }) {
  const effectiveMaxChars = Number.isFinite(maxChars) ? maxChars : computeMaxChars({ maxWordCount });
  return [
    '이 이미지는 회의에서 공유 중인 화면이다.',
    '청자는 시각장애인이며, 화면에 대해 **직접 물어본 질문**에 답하는 중이다.',
    '',
    `질문: "${questionText}"`,
    recentTranscript ? `참고로 최근 발화 맥락은 다음과 같다: ${recentTranscript}` : '',
    '',
    '규칙:',
    '(1) 화면에 실제로 보이는 것에 근거해 답한다. 지어내지 않는다.',
    `(2) 화면에서 질문의 답을 찾을 수 없으면 정확히 "${GROUNDING_NONE_TOKEN}"만 출력한다.`,
    `(3) ${minWordCount}~${maxWordCount}어절로 답한다 (최대 ${effectiveMaxChars}자).`,
    '(4) 머리말·인사말 없이 답만 출력한다.',
    '(5) 이미 안내했던 내용이라도 **다시 답한다** — 사용자가 직접 물었기 때문이다.',
  ].filter(Boolean).join('\n');
}

module.exports = {
  buildCommandPrompt, buildFreeQuestionPrompt, USER_COMMAND_RULE_MAP,
  DEFAULT_COMMAND_MIN_WORD_COUNT, DEFAULT_COMMAND_MAX_WORD_COUNT,
};
