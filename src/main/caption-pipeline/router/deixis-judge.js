const { createJudgeLlm } = require('../agents/shared/judge-llm');
const {
  JUDGE_REASON_MAP, JUDGE_SYSTEM_PROMPT, FEW_SHOT_LIST,
} = require('../prompts/deixis-judge');

const REQUEST_TIMEOUT_MS = 15000;
const MAX_JUDGE_TOKENS = 40;
const JUDGE_SOURCE_MAP = { gpu: 'gpu', error: 'error' };

function buildJudgeInput({ before = '', utterance, after = '' }) {
  return [
    `앞 맥락: ${before || '(없음)'}`,
    `지시 발화: "${utterance}"`,
    `뒤 맥락(look-ahead): ${after || '(없음)'}`,
    '판정(JSON 한 줄):',
  ].join('\n');
}

function buildFewShotMessageList() {
  return FEW_SHOT_LIST.flatMap((example) => [
    { role: 'user', content: [{ text: buildJudgeInput(example.input) }] },
    { role: 'assistant', content: [{ text: JSON.stringify(example.output) }] },
  ]);
}

function parseJudgeText(text) {
  if (typeof text !== 'string') return { shouldCaption: true, reason: null };
  const match = text.replace(/```(?:json)?/g, '').match(/\{[^{}]*\}/);
  if (!match) {
    return { shouldCaption: !/false/i.test(text), reason: null };
  }
  try {
    const parsed = JSON.parse(match[0]);
    return { shouldCaption: Boolean(parsed.caption), reason: typeof parsed.reason === 'string' ? parsed.reason : null };
  } catch {
    return { shouldCaption: true, reason: null };
  }
}

function createDeixisJudgeClient({ config, judgeLlm = createJudgeLlm({ config }) }) {
  async function judge({ utterance, before = '', after = '' }) {
    try {
      const { text, source } = await judgeLlm.requestText({
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        messageList: [
          ...buildFewShotMessageList(),
          { role: 'user', content: [{ text: buildJudgeInput({ before, utterance, after }) }] },
        ],
        maxTokens: MAX_JUDGE_TOKENS, timeoutMs: REQUEST_TIMEOUT_MS, label: '지시 판정',
      });
      return { ...parseJudgeText(text), source };
    } catch (error) {
      console.error('[pipeline] 지시 판정기 실패, 통과 처리:', error.message);
      return { shouldCaption: true, reason: null, source: JUDGE_SOURCE_MAP.error };
    }
  }

  return { judge };
}

module.exports = { createDeixisJudgeClient, parseJudgeText, buildJudgeInput, JUDGE_REASON_MAP };
