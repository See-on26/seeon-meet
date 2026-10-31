const { createJudgeLlm } = require('../agents/shared/judge-llm');
const {
  SILENCE_JUDGE_SYSTEM_PROMPT, SILENCE_FEW_SHOT_LIST, buildSilenceJudgeInput,
} = require('../prompts/silence-judge');

const REQUEST_TIMEOUT_MS = 8000;
// 상한이 작으면 JSON 이 잘려(max_tokens) 단서가 있어도 차단된다.
const MAX_JUDGE_TOKENS = 400;
const SILENCE_JUDGE_SOURCE_MAP = { gpu: 'gpu', empty: 'empty', error: 'error' };

// 무발화 해설은 애매하면 내지 않는다. cue 가 정확히 true 인 JSON 이 아니면 모두 차단으로 읽는다.
function parseSilenceJudgeText(text) {
  if (typeof text !== 'string') return { hasCue: false, reason: null };
  const match = text.replace(/```(?:json)?/g, '').match(/\{[^{}]*\}/);
  if (!match) return { hasCue: false, reason: null };
  try {
    const parsed = JSON.parse(match[0]);
    return { hasCue: parsed.cue === true, reason: typeof parsed.reason === 'string' ? parsed.reason : null };
  } catch {
    return { hasCue: false, reason: null };
  }
}

function buildFewShotMessageList() {
  return SILENCE_FEW_SHOT_LIST.flatMap((example) => [
    { role: 'user', content: [{ text: buildSilenceJudgeInput(example.input) }] },
    { role: 'assistant', content: [{ text: JSON.stringify(example.output) }] },
  ]);
}

function createSilenceJudge({ config, judgeLlm = createJudgeLlm({ config }) }) {
  async function judge({ transcript, silenceMs }) {
    if (typeof transcript !== 'string' || !transcript.trim()) {
      return { hasCue: false, reason: null, source: SILENCE_JUDGE_SOURCE_MAP.empty };
    }
    try {
      const { text, source } = await judgeLlm.requestText({
        systemPrompt: SILENCE_JUDGE_SYSTEM_PROMPT,
        messageList: [
          ...buildFewShotMessageList(),
          { role: 'user', content: [{ text: buildSilenceJudgeInput({ transcript, silenceMs }) }] },
        ],
        maxTokens: MAX_JUDGE_TOKENS, timeoutMs: REQUEST_TIMEOUT_MS, label: '무발화 판정',
      });
      return { ...parseSilenceJudgeText(text), source };
    } catch (error) {
      return { hasCue: false, reason: error.message, source: SILENCE_JUDGE_SOURCE_MAP.error };
    }
  }

  return { judge };
}

module.exports = { createSilenceJudge, parseSilenceJudgeText, SILENCE_JUDGE_SOURCE_MAP };
