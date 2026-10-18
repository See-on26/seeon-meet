const { USER_COMMAND_MAP } = require('../contracts/narration-types');
const { GROUNDING_NONE_TOKEN, computeMaxChars, parseGroundingText } = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const { scaleWordBudget } = require('./shared/narration-format');
const {
  buildCommandPrompt, buildFreeQuestionPrompt,
  USER_COMMAND_RULE_MAP, DEFAULT_COMMAND_MIN_WORD_COUNT, DEFAULT_COMMAND_MAX_WORD_COUNT,
} = require('../prompts/command-processing');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');

const AGENT_LABEL = '커맨드';
const COMMAND_MAX_TOKENS = 300;

function createCommandProcessingAgent({ config, getCaptionLanguage = () => DEFAULT_CAPTION_LANGUAGE }) {
  // command(프리셋 3종) 또는 questionText(자유 자연어 질문) 중 하나를 받는다.
  // 자유 질문이면 최근 발화(recentTranscript)를 함께 근거로 쓴다 — 심화 질의응답 경로.
  async function generate({ jpegBuffer, command = null, questionText = null, recentTranscript = '', contextText = '',
    qaHistoryText = '', minWordCount = DEFAULT_COMMAND_MIN_WORD_COUNT, maxWordCount = DEFAULT_COMMAND_MAX_WORD_COUNT,
    language = getCaptionLanguage() }) {
    // 렌더러의 어절 예산을 캡션 언어의 단어 수로 바꾼다(영어는 상한을 ENGLISH_WORD_SCALE 배로, 한국어는 그대로).
    ({ minWordCount, maxWordCount } = scaleWordBudget({ minWordCount, maxWordCount, language }));
    const effectiveMaxChars = computeMaxChars({ maxWordCount, language });
    const prompt = questionText
      ? buildFreeQuestionPrompt({
        questionText, recentTranscript, contextText, qaHistoryText, minWordCount, maxWordCount, maxChars: effectiveMaxChars,
        language,
      })
      : buildCommandPrompt({
        command, minWordCount, maxWordCount, maxChars: effectiveMaxChars, language,
      });
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, maxTokens: COMMAND_MAX_TOKENS, prompt,
    });
    return parseGroundingText(content, effectiveMaxChars, maxWordCount, language);
  }

  return { generate };
}

module.exports = { createCommandProcessingAgent, buildCommandPrompt, USER_COMMAND_RULE_MAP };
