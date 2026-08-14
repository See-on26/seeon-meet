const { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, parseSlotCaption,
} = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const {
  buildVisualDescriptionPrompt, DEFAULT_VISUAL_WORD_RANGE_MAP,
} = require('../prompts/visual-description');

const AGENT_LABEL = '시각묘사';

const VISUAL_DESCRIPTION_TEMPERATURE = 0.3;

function createVisualDescriptionAgent({ config }) {
  async function generate({ jpegBuffer, subKind = VISUAL_DESCRIPTION_KIND_MAP.reaction,
    utterance = '', recentTranscript = '', minWordCount, maxWordCount,
    describedElementList = [], mergedAnchorList = [] }) {
    const defaultRange = DEFAULT_VISUAL_WORD_RANGE_MAP[subKind]
      || DEFAULT_VISUAL_WORD_RANGE_MAP[VISUAL_DESCRIPTION_KIND_MAP.reaction];
    const effectiveMaxWordCount = Number.isFinite(maxWordCount) ? maxWordCount : defaultRange.maxWordCount;
    const effectiveMaxChars = computeMaxChars({ maxWordCount: effectiveMaxWordCount });
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, temperature: VISUAL_DESCRIPTION_TEMPERATURE,
      prompt: buildVisualDescriptionPrompt({
        subKind, utterance, recentTranscript, minWordCount, maxWordCount,
        maxChars: effectiveMaxChars, describedElementList, mergedAnchorList,
      }),
    });
    return parseSlotCaption({
      content,
      narrationType: NARRATION_TYPE_MAP.visualDescription, subKind,
      maxChars: effectiveMaxChars, maxWordCount: effectiveMaxWordCount,
    });
  }

  return { generate };
}

module.exports = {
  createVisualDescriptionAgent, buildVisualDescriptionPrompt, DEFAULT_VISUAL_WORD_RANGE_MAP,
};
