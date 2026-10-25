const { requestVlmCompletion, VLM_PRIORITY_MAP } = require('../agents/shared/vlm-gateway');
const {
  buildSummarySystemPrompt,
} = require('../prompts/meeting-summary');

const AGENT_LABEL = '회의 요약';

const SUMMARY_MAX_TOKENS = 6000;

const SUMMARY_TIMEOUT_MS = 240000;
const SUMMARY_TEMPERATURE = 0.2;
const FINISH_REASON_LENGTH = 'length';

// 회의 후 처리의 "회의 요약 에이전트" — 구간 요약을 모은 통합 입력 한 건을 GPU 서버(8801)에서 요약한다.
// 회의 뒤에 돌지만 다음 회의의 실시간 해설을 막지 않도록 배경 순위로 보낸다. HTTP 오류·시간 초과·빈 답은 던진다.
function createMeetingSummaryAgent({ config, requestCompletion = requestVlmCompletion }) {
  // language 는 그 회의의 캡션 언어다. 영어면 요약을 영어로 쓴다.
  async function summarize({ integrationText, language = 'ko' }) {
    const { content, finishReason } = await requestCompletion({
      config,
      prompt: `${buildSummarySystemPrompt({ language })}\n\n${integrationText}`,
      label: AGENT_LABEL,
      temperature: SUMMARY_TEMPERATURE,
      maxTokens: SUMMARY_MAX_TOKENS,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      priority: VLM_PRIORITY_MAP.background,
    });

    // 응답이 깨지면 content 가 글이 아닐 수 있다. 그때도 빈 답으로 본다.
    const cleaned = typeof content === 'string' ? content.replace(/```[a-zA-Z]*\n?/g, '').trim() : '';
    if (!cleaned) throw new Error(`${AGENT_LABEL}: 모델 응답이 비어 있습니다`);
    return { text: cleaned, isTruncated: finishReason === FINISH_REASON_LENGTH };
  }

  return { summarize };
}

module.exports = {
  createMeetingSummaryAgent, buildSummarySystemPrompt,
  SUMMARY_MAX_TOKENS, SUMMARY_TIMEOUT_MS,
};
