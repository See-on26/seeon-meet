const { NARRATION_TYPE_MAP, DEIXIS_FORM_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, parseSlotCaption,
} = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const {
  buildGroundingPrompt, DEIXIS_FORM_RULE_MAP, DEFAULT_DEIXIS_MIN_WORD_COUNT, DEFAULT_DEIXIS_MAX_WORD_COUNT,
} = require('../prompts/deixis-resolution');

const AGENT_LABEL = '그라운딩';

function createDeixisResolutionAgent({ config }) {
  async function generate({ jpegBuffer, utterance, recentTranscript = '',
    maxChars = null, hasPointingRegion = false, pointingOrderHint = '',
    describedElementList = [], minWordCount = DEFAULT_DEIXIS_MIN_WORD_COUNT,
    maxWordCount = DEFAULT_DEIXIS_MAX_WORD_COUNT, subKind = null, mergedAnchorList = [] }) {
    const effectiveMaxChars = Number.isFinite(maxChars) ? maxChars : computeMaxChars({ maxWordCount });
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL,
      prompt: buildGroundingPrompt({
        utterance, recentTranscript, maxChars: effectiveMaxChars, hasPointingRegion,
        pointingOrderHint, describedElementList, minWordCount, maxWordCount, subKind, mergedAnchorList,
      }),
    });
    return parseSlotCaption({
      content,
      narrationType: NARRATION_TYPE_MAP.deixis, subKind: subKind || DEIXIS_FORM_MAP.simple,
      maxChars: effectiveMaxChars, maxWordCount,
    });
  }

  return { generate };
}

module.exports = { createDeixisResolutionAgent, buildGroundingPrompt, DEIXIS_FORM_RULE_MAP };
