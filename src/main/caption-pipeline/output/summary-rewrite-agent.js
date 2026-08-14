const { requestConverseText } = require('../agents/shared/bedrock-converse');
const {
  buildSummaryRewriteSystemPrompt, buildSummaryRewriteInput,
} = require('../prompts/summary-rewrite');

const AGENT_LABEL = '회의 요약 재구성';

const REWRITE_MAX_TOKENS = 16000;

const REWRITE_TIMEOUT_MS = 300000;

// 제안서 3.1.2⑨의 "요약문 작성 에이전트" — 회의 요약 파이프라인 3단계(낭독용 듣는 글로 재구성).
function createSummaryRewriteAgent({ config }) {
  // Opus가 만든 요약 초안을 Sonnet으로 낭독용 "듣는 글"로 다듬는다.
  // 실패하면 초안을 그대로 돌려주어 요약 자체가 끊기지 않게 한다.
  async function rewrite({ draftText, isTruncated = false }) {
    try {
      const { text, stopReason } = await requestConverseText({
        config,
        modelId: config.summaryRewriteModelId,
        systemPrompt: buildSummaryRewriteSystemPrompt(),
        messageList: [{ role: 'user', content: [{ text: buildSummaryRewriteInput({ draftText }) }] }],
        maxTokens: REWRITE_MAX_TOKENS,
        timeoutMs: REWRITE_TIMEOUT_MS,
        label: AGENT_LABEL,
      });

      const cleaned = text.replace(/```[a-zA-Z]*\n?/g, '').trim();
      if (!cleaned) throw new Error('모델 응답이 비어 있음');
      return { text: cleaned, isTruncated: isTruncated || stopReason === 'max_tokens', isRewritten: true };
    } catch (error) {
      console.warn(`[summary] ${AGENT_LABEL} 실패, 요약 초안 그대로 사용: ${error.message}`);
      return { text: draftText, isTruncated, isRewritten: false };
    }
  }

  return { rewrite };
}

module.exports = {
  createSummaryRewriteAgent, REWRITE_MAX_TOKENS, REWRITE_TIMEOUT_MS,
};
