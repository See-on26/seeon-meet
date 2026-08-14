const { NARRATION_TYPE_MAP, INTERPRETATION_KIND_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, parseSlotCaption,
} = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const {
  buildInterpretationPrompt, INTERPRETATION_RULE_MAP, DEFAULT_INTERPRETATION_MIN_WORD_COUNT, DEFAULT_INTERPRETATION_MAX_WORD_COUNT,
} = require('../prompts/interpretive-bridge');

const AGENT_LABEL = '해석연결';

function createInterpretiveBridgeAgent({ config }) {
  async function generate({ jpegBuffer, utterance, recentTranscript = '',
    subKind = null, minWordCount = DEFAULT_INTERPRETATION_MIN_WORD_COUNT,
    maxWordCount = DEFAULT_INTERPRETATION_MAX_WORD_COUNT,
    describedElementList = [], mergedAnchorList = [] }) {
    const effectiveMaxChars = computeMaxChars({ maxWordCount });
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL,
      prompt: buildInterpretationPrompt({
        utterance, recentTranscript, subKind, minWordCount, maxWordCount,
        maxChars: effectiveMaxChars, describedElementList, mergedAnchorList,
      }),
    });
    return parseSlotCaption({
      content,
      narrationType: NARRATION_TYPE_MAP.interpretation,
      subKind: subKind || INTERPRETATION_KIND_MAP.valueToMeaning,
      maxChars: effectiveMaxChars, maxWordCount,
    });
  }

  return { generate };
}

module.exports = {
  createInterpretiveBridgeAgent, buildInterpretationPrompt, INTERPRETATION_RULE_MAP,
};
