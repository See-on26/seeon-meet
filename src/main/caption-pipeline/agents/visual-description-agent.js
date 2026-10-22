const { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, parseSlotCaption, SLOT_AGENT_MAX_TOKENS,
} = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const { scaleWordBudget } = require('./shared/narration-format');
const { resolveContentSwitch } = require('./shared/content-switch');
const { toZoomImageArgs, toZoomPromptArgs } = require('./shared/zoom-image');
const {
  buildVisualDescriptionPrompt, buildScaleScreenTextBlock, DEFAULT_VISUAL_WORD_RANGE_MAP,
} = require('../prompts/visual-description');
const { buildFactCardBlock, FACT_CARD_USAGE_MAP } = require('../prompts/fact-card-block');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');
const { NARRATION_ORIGIN_MAP } = require('../contracts/narration-class');

const AGENT_LABEL = '시각묘사';

// 무발화 묘사는 칸이 하나라 모델이 JSON 없이 묘사만 쓰는 일이 있다. 그대로 두면 일반 글 경로가 어절 상한에서 잘라
// 자료 명사 꼬리가 빠지므로("…가장 적고 양식"), 칸 하나짜리 JSON 으로 감싸 칸 규칙(허용치·자료 명사 지점 자르기)을 똑같이 쓴다.
const SILENCE_PREFIX_PATTERN = /^\s*(?:이미지 제시|image\s*(?:presented|shown)?)\s*[:,]?\s*/i;

function wrapPlainSilenceContent({ content, origin }) {
  if (origin !== NARRATION_ORIGIN_MAP.silence || typeof content !== 'string') return content;
  const trimmed = content.trim();
  if (!trimmed || trimmed.includes('{') || trimmed.toUpperCase().includes(GROUNDING_NONE_TOKEN)) return content;
  return JSON.stringify({ description: trimmed.replace(SILENCE_PREFIX_PATTERN, '') });
}

const VISUAL_DESCRIPTION_TEMPERATURE = 0.3;

function createVisualDescriptionAgent({ config, getCaptionLanguage = () => DEFAULT_CAPTION_LANGUAGE }) {
  async function generate({ jpegBuffer, subKind = VISUAL_DESCRIPTION_KIND_MAP.reaction,
    utterance = '', recentTranscript = '', minWordCount, maxWordCount,
    describedElementList = [], mergedAnchorList = [], origin = null, screenLineList = [], factCardList = [],
    language = getCaptionLanguage(), zoomJpegBuffer = null, zoomKind = null, zoomTerm = null }) {
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
    const contentSwitch = resolveContentSwitch(config?.contentSwitch);
    // 확대 그림(발화 ROI)은 척도 해설만 받는다. 반응·무발화 묘사는 지금처럼 한 장이다.
    const zoomArgs = { zoomJpegBuffer: subKind === VISUAL_DESCRIPTION_KIND_MAP.scale ? zoomJpegBuffer : null, zoomKind, zoomTerm };
    const content = await requestVlmContent({
      config, ...toZoomImageArgs({ jpegBuffer, zoomJpegBuffer: zoomArgs.zoomJpegBuffer }), label: AGENT_LABEL,
      temperature: VISUAL_DESCRIPTION_TEMPERATURE, maxTokens: SLOT_AGENT_MAX_TOKENS,
      prompt: buildVisualDescriptionPrompt({
        subKind, utterance, recentTranscript, minWordCount, maxWordCount,
        maxChars: effectiveMaxChars, describedElementList, mergedAnchorList, origin, screenLineList, factCardList, language, contentSwitch,
        ...toZoomPromptArgs(zoomArgs),
      }),
    });
    const parsed = parseSlotCaption({
      content: wrapPlainSilenceContent({ content, origin }),
      narrationType: NARRATION_TYPE_MAP.visualDescription, subKind, origin,
      maxChars: effectiveMaxChars, maxWordCount: effectiveMaxWordCount, language, contentSwitch,
    });
    if (subKind !== VISUAL_DESCRIPTION_KIND_MAP.scale) return parsed;
    // 척도는 프롬프트에 실제로 들어간 화면 글자·사실 카드 양을 기록용으로 함께 돌려준다.
    const { lineCount, charCount, numberLineCount } = buildScaleScreenTextBlock({
      screenLineList, utterance, mergedAnchorList, contentSwitch,
    });
    const factCardBlock = buildFactCardBlock({ cardList: factCardList, usage: FACT_CARD_USAGE_MAP.scale });
    return {
      ...parsed,
      screenTextBlock: { lineCount, charCount, numberLineCount },
      factCardBlock: { cardCount: factCardBlock.cardCount, charCount: factCardBlock.charCount },
    };
  }

  return { generate };
}

module.exports = {
  createVisualDescriptionAgent, buildVisualDescriptionPrompt, DEFAULT_VISUAL_WORD_RANGE_MAP, wrapPlainSilenceContent,
};
