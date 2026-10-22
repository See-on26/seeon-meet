const { NARRATION_TYPE_MAP, DEIXIS_FORM_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, parseSlotCaption, SLOT_AGENT_MAX_TOKENS,
} = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const { scaleWordBudget } = require('./shared/narration-format');
const { resolveContentSwitch } = require('./shared/content-switch');
const {
  buildGroundingPrompt, DEIXIS_FORM_RULE_MAP, DEFAULT_DEIXIS_MIN_WORD_COUNT, DEFAULT_DEIXIS_MAX_WORD_COUNT,
} = require('../prompts/deixis-resolution');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');

const AGENT_LABEL = '그라운딩';

function createDeixisResolutionAgent({ config, getCaptionLanguage = () => DEFAULT_CAPTION_LANGUAGE }) {
  async function generate({ jpegBuffer, utterance, recentTranscript = '',
    maxChars = null, hasPointingRegion = false, pointingOrderHint = '', minWordCount = DEFAULT_DEIXIS_MIN_WORD_COUNT,
    maxWordCount = DEFAULT_DEIXIS_MAX_WORD_COUNT, subKind = null, mergedAnchorList = [], language = getCaptionLanguage() }) {
    // 렌더러의 어절 예산을 캡션 언어의 단어 수로 바꾼다(영어는 상한을 ENGLISH_WORD_SCALE 배로, 한국어는 그대로).
    ({ minWordCount, maxWordCount } = scaleWordBudget({ minWordCount, maxWordCount, language }));
    const effectiveMaxChars = Number.isFinite(maxChars) ? maxChars : computeMaxChars({ maxWordCount, language });
    const contentSwitch = resolveContentSwitch(config?.contentSwitch);
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, maxTokens: SLOT_AGENT_MAX_TOKENS,
      prompt: buildGroundingPrompt({
        utterance, recentTranscript, maxChars: effectiveMaxChars, hasPointingRegion,
        pointingOrderHint, minWordCount, maxWordCount, subKind, mergedAnchorList, language, contentSwitch,
      }),
    });
    return parseSlotCaption({
      content,
      narrationType: NARRATION_TYPE_MAP.deixis, subKind: subKind || DEIXIS_FORM_MAP.simple,
      maxChars: effectiveMaxChars, maxWordCount, language, contentSwitch,
    });
  }

  return { generate };
}

module.exports = { createDeixisResolutionAgent, buildGroundingPrompt, DEIXIS_FORM_RULE_MAP };
