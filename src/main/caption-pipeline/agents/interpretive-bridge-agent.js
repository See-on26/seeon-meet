const { NARRATION_TYPE_MAP, INTERPRETATION_KIND_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, parseSlotCaption, SLOT_AGENT_MAX_TOKENS,
} = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const { scaleWordBudget } = require('./shared/narration-format');
const {
  buildInterpretationPrompt, buildInterpretationScreenTextBlock, INTERPRETATION_RULE_MAP,
  DEFAULT_INTERPRETATION_MIN_WORD_COUNT, DEFAULT_INTERPRETATION_MAX_WORD_COUNT,
} = require('../prompts/interpretive-bridge');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');

const AGENT_LABEL = '해석연결';

function createInterpretiveBridgeAgent({ config, getCaptionLanguage = () => DEFAULT_CAPTION_LANGUAGE }) {
  async function generate({ jpegBuffer, utterance, recentTranscript = '',
    subKind = null, minWordCount = DEFAULT_INTERPRETATION_MIN_WORD_COUNT,
    maxWordCount = DEFAULT_INTERPRETATION_MAX_WORD_COUNT,
    describedElementList = [], mergedAnchorList = [], mergedClaimList = [], screenLineList = [],
    language = getCaptionLanguage() }) {
    // 렌더러의 어절 예산을 캡션 언어의 단어 수로 바꾼다(영어는 상한을 ENGLISH_WORD_SCALE 배로, 한국어는 그대로).
    ({ minWordCount, maxWordCount } = scaleWordBudget({ minWordCount, maxWordCount, language }));
    const effectiveMaxChars = computeMaxChars({ maxWordCount, language });
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, maxTokens: SLOT_AGENT_MAX_TOKENS,
      prompt: buildInterpretationPrompt({
        utterance, recentTranscript, subKind, minWordCount, maxWordCount,
        maxChars: effectiveMaxChars, describedElementList, mergedAnchorList, mergedClaimList, screenLineList, language,
      }),
    });
    // 프롬프트에 실제로 들어간 화면 글자 양을 기록용으로 함께 돌려준다.
    const { lineCount, charCount, numberLineCount } = buildInterpretationScreenTextBlock({
      screenLineList, utterance, subKind, mergedAnchorList, mergedClaimList,
    });
    return {
      ...parseSlotCaption({
        content,
        narrationType: NARRATION_TYPE_MAP.interpretation,
        subKind: subKind || INTERPRETATION_KIND_MAP.valueToMeaning,
        maxChars: effectiveMaxChars, maxWordCount, hasSecondClaim: mergedClaimList.length > 0, language,
      }),
      screenTextBlock: { lineCount, charCount, numberLineCount },
    };
  }

  return { generate };
}

module.exports = {
  createInterpretiveBridgeAgent, buildInterpretationPrompt, INTERPRETATION_RULE_MAP,
};
