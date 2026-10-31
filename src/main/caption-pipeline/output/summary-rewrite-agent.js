const { requestVlmCompletion, VLM_PRIORITY_MAP } = require('../agents/shared/vlm-gateway');
const {
  buildSummaryRewriteSystemPrompt, buildSummaryRewriteInput,
} = require('../prompts/summary-rewrite');

const AGENT_LABEL = '회의 요약 재구성';

const REWRITE_MAX_TOKENS = 6000;

const REWRITE_TIMEOUT_MS = 240000;
const REWRITE_TEMPERATURE = 0.2;
const FINISH_REASON_LENGTH = 'length';

// 제안서 3.1.2⑨의 "요약문 작성 에이전트" — 회의 요약 파이프라인 3단계(낭독용 듣는 글로 재구성).
function createSummaryRewriteAgent({ config, requestCompletion = requestVlmCompletion }) {
  // 요약 초안을 GPU 서버(8801)에서 낭독용 "듣는 글"로 다듬는다. 요약 에이전트처럼 배경 순위로 보낸다.
  // 실패하거나 답이 비면 초안을 그대로 돌려주어 요약 자체가 끊기지 않게 한다.
  async function rewrite({ draftText, isTruncated = false, language = 'ko' }) {
    try {
      const { content, finishReason } = await requestCompletion({
        config,
        prompt: `${buildSummaryRewriteSystemPrompt({ language })}\n\n${buildSummaryRewriteInput({ draftText, language })}`,
        label: AGENT_LABEL,
        temperature: REWRITE_TEMPERATURE,
        maxTokens: REWRITE_MAX_TOKENS,
        timeoutMs: REWRITE_TIMEOUT_MS,
        priority: VLM_PRIORITY_MAP.background,
      });

      const cleaned = typeof content === 'string' ? content.replace(/```[a-zA-Z]*\n?/g, '').trim() : '';
      if (!cleaned) throw new Error('모델 응답이 비어 있음');
      return { text: cleaned, isTruncated: isTruncated || finishReason === FINISH_REASON_LENGTH, isRewritten: true };
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
