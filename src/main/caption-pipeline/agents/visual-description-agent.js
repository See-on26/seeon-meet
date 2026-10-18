const { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, parseSlotCaption, SLOT_AGENT_MAX_TOKENS,
} = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const { scaleWordBudget } = require('./shared/narration-format');
const {
  buildVisualDescriptionPrompt, DEFAULT_VISUAL_WORD_RANGE_MAP,
} = require('../prompts/visual-description');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');

const AGENT_LABEL = '시각묘사';

const VISUAL_DESCRIPTION_TEMPERATURE = 0.3;

function createVisualDescriptionAgent({ config, getCaptionLanguage = () => DEFAULT_CAPTION_LANGUAGE }) {
  async function generate({ jpegBuffer, subKind = VISUAL_DESCRIPTION_KIND_MAP.reaction,
    utterance = '', recentTranscript = '', minWordCount, maxWordCount,
    describedElementList = [], mergedAnchorList = [], origin = null, language = getCaptionLanguage() }) {
    const defaultRange = DEFAULT_VISUAL_WORD_RANGE_MAP[subKind]
      || DEFAULT_VISUAL_WORD_RANGE_MAP[VISUAL_DESCRIPTION_KIND_MAP.reaction];
    // 렌더러의 어절 예산을 캡션 언어의 단어 수로 바꾼다(영어는 상한을 ENGLISH_WORD_SCALE 배로, 한국어는 그대로). 받지 못한 값은 기본 범위를 바꾼다.
    if (language !== DEFAULT_CAPTION_LANGUAGE) {
      ({ minWordCount, maxWordCount } = scaleWordBudget({
        minWordCount: minWordCount ?? defaultRange.minWordCount, maxWordCount: maxWordCount ?? defaultRange.maxWordCount, language,
      }));
    }
    const effectiveMaxWordCount = Number.isFinite(maxWordCount) ? maxWordCount : defaultRange.maxWordCount;
    const effectiveMaxChars = computeMaxChars({ maxWordCount: effectiveMaxWordCount, language });
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, temperature: VISUAL_DESCRIPTION_TEMPERATURE, maxTokens: SLOT_AGENT_MAX_TOKENS,
      prompt: buildVisualDescriptionPrompt({
        subKind, utterance, recentTranscript, minWordCount, maxWordCount,
        maxChars: effectiveMaxChars, describedElementList, mergedAnchorList, origin, language,
      }),
    });
    return parseSlotCaption({
      content,
      narrationType: NARRATION_TYPE_MAP.visualDescription, subKind, origin,
      maxChars: effectiveMaxChars, maxWordCount: effectiveMaxWordCount, language,
    });
  }

  return { generate };
}

module.exports = {
  createVisualDescriptionAgent, buildVisualDescriptionPrompt, DEFAULT_VISUAL_WORD_RANGE_MAP,
};
