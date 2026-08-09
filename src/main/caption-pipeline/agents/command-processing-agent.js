const { USER_COMMAND_MAP } = require('../contracts/narration-types');
const { GROUNDING_NONE_TOKEN, computeMaxChars, parseGroundingText } = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');

const AGENT_LABEL = '커맨드';
const COMMAND_MAX_TOKENS = 300;

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

function createCommandProcessingAgent({ config }) {
  async function generate({ jpegBuffer, command,
    minWordCount = DEFAULT_COMMAND_MIN_WORD_COUNT, maxWordCount = DEFAULT_COMMAND_MAX_WORD_COUNT }) {
    const effectiveMaxChars = computeMaxChars({ maxWordCount });
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, maxTokens: COMMAND_MAX_TOKENS,
      prompt: buildCommandPrompt({
        command, minWordCount, maxWordCount, maxChars: effectiveMaxChars,
      }),
    });
    return parseGroundingText(content, effectiveMaxChars, maxWordCount);
  }

  return { generate };
}

module.exports = { createCommandProcessingAgent, buildCommandPrompt, USER_COMMAND_RULE_MAP };
