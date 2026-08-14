const { USER_COMMAND_MAP } = require('../contracts/narration-types');
const { GROUNDING_NONE_TOKEN, computeMaxChars, parseGroundingText } = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const {
  buildCommandPrompt, buildFreeQuestionPrompt,
  USER_COMMAND_RULE_MAP, DEFAULT_COMMAND_MIN_WORD_COUNT, DEFAULT_COMMAND_MAX_WORD_COUNT,
} = require('../prompts/command-processing');

const AGENT_LABEL = '커맨드';
const COMMAND_MAX_TOKENS = 300;

function createCommandProcessingAgent({ config }) {
  // command(프리셋 3종) 또는 questionText(자유 자연어 질문) 중 하나를 받는다.
  // 자유 질문이면 최근 발화(recentTranscript)를 함께 근거로 쓴다 — 심화 질의응답 경로.
  async function generate({ jpegBuffer, command = null, questionText = null, recentTranscript = '',
    minWordCount = DEFAULT_COMMAND_MIN_WORD_COUNT, maxWordCount = DEFAULT_COMMAND_MAX_WORD_COUNT }) {
    const effectiveMaxChars = computeMaxChars({ maxWordCount });
    const prompt = questionText
      ? buildFreeQuestionPrompt({
        questionText, recentTranscript, minWordCount, maxWordCount, maxChars: effectiveMaxChars,
      })
      : buildCommandPrompt({
        command, minWordCount, maxWordCount, maxChars: effectiveMaxChars,
      });
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, maxTokens: COMMAND_MAX_TOKENS, prompt,
    });
    return parseGroundingText(content, effectiveMaxChars, maxWordCount);
  }

  return { generate };
}

module.exports = { createCommandProcessingAgent, buildCommandPrompt, USER_COMMAND_RULE_MAP };
