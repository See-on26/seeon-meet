const { requestConverseText } = require('../agents/shared/bedrock-converse');
const {
  buildSummarySystemPrompt,
} = require('../prompts/meeting-summary');

const AGENT_LABEL = '회의 요약';

const SUMMARY_MAX_TOKENS = 16000;

const SUMMARY_TIMEOUT_MS = 300000;

const SCREEN_LINE_PATTERN = /^\[[^\]]+\] ──/m;

// 회의 스크립트(화자 이름을 뺀 것)를 그대로 요약 재료로 준다. 화면 전환 줄이 없으면 대화만 오간 회의다.
function buildSummaryInput({ scriptText }) {
  const script = String(scriptText || '').trim();
  const screenNote = SCREEN_LINE_PATTERN.test(script)
    ? '"──"로 둘러싼 줄은 그 시각에 공유 화면이 바뀌며 들려준 화면 설명이고, 나머지 줄은 오간 말이다.'
    : '이 회의에서는 공유 화면 전환이 감지되지 않았다. 화면 자료 없이 대화만 오갔다.';
  return [
    '아래는 회의 한 건의 스크립트다. 줄 앞의 [분:초]는 회의 시작부터 지난 시간이다.',
    screenNote,
    '',
    script,
  ].join('\n');
}

// 회의 후 처리의 "회의 요약 에이전트" — 회의 스크립트 작성 단계가 만든 스크립트 한 건을 요약한다.
function createMeetingSummaryAgent({ config }) {
  async function summarize({ scriptText }) {
    const { text, stopReason } = await requestConverseText({
      config,
      modelId: config.summaryModelId,
      systemPrompt: buildSummarySystemPrompt(),
      messageList: [{ role: 'user', content: [{ text: buildSummaryInput({ scriptText }) }] }],
      maxTokens: SUMMARY_MAX_TOKENS,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      label: AGENT_LABEL,
    });

    const cleaned = text.replace(/```[a-zA-Z]*\n?/g, '').trim();
    if (!cleaned) throw new Error(`${AGENT_LABEL}: 모델 응답이 비어 있습니다`);
    return { text: cleaned, isTruncated: stopReason === 'max_tokens' };
  }

  return { summarize };
}

module.exports = {
  createMeetingSummaryAgent, buildSummarySystemPrompt, buildSummaryInput,
  SUMMARY_MAX_TOKENS, SUMMARY_TIMEOUT_MS,
};
