const { NARRATION_TYPE_MAP, PAGE_TRANSITION_KIND_MAP } = require('../contracts/narration-types');
const {
  getSlotList, truncateSlot, normalizeSlotMap, DESCRIPTION_TAIL_NOUN_LIST, hasCompleteTailNoun,
} = require('./shared/narration-format');
const { truncateToWordCount } = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const {
  buildPageTransitionPrompt, SCREEN_TYPE_LIST, DEFAULT_TRANSITION_MIN_WORD_COUNT, DEFAULT_TRANSITION_MAX_WORD_COUNT,
} = require('../prompts/page-transition');

const AGENT_LABEL = '전환';
const PAGE_TRANSITION_MAX_TOKENS = 220;

function normalizePageTransition(parsed) {
  const description = typeof parsed?.description === 'string' && parsed.description.trim()
    ? parsed.description : parsed?.narration;
  if (!parsed || typeof description !== 'string' || !description.trim()) return null;
  const screenType = SCREEN_TYPE_LIST.includes(parsed.screenType) ? parsed.screenType : 'etc';
  const subKind = screenType === 'ppt'
    ? PAGE_TRANSITION_KIND_MAP.slide : PAGE_TRANSITION_KIND_MAP.document;
  const slotList = getSlotList({
    narrationType: NARRATION_TYPE_MAP.pageTransition, subKind,
  });
  const descriptionSlot = slotList.find((slot) => slot.key === 'description');

  const descriptionText = normalizeSlotMap({
    slotList: [descriptionSlot], rawSlotMap: { description },
  }).description;
  const screenFormSlot = slotList.find((slot) => slot.key === 'screenForm');
  const screenForm = screenFormSlot
    ? truncateSlot({ text: parsed.screenForm || '', maxWordCount: screenFormSlot.maxWordCount })
    : '';
  const isTailComplete = hasCompleteTailNoun({ text: descriptionText });
  return {
    screenType,
    pageNumber: Number.isFinite(parsed.pageNumber) ? Number(parsed.pageNumber) : null,
    pageTopic: typeof parsed.pageTopic === 'string' ? parsed.pageTopic : '',
    isPhotoOnly: parsed.isPhotoOnly === true,
    screenForm,
    description: isTailComplete ? descriptionText : '',
    rejectedDescription: isTailComplete ? '' : descriptionText,
    rejectedRawDescription: isTailComplete ? '' : description.trim(),
    subKind,
    narration: !isTailComplete ? '' : (subKind === PAGE_TRANSITION_KIND_MAP.slide
      ? descriptionText
      : [screenForm, descriptionText].filter(Boolean).join(', ')),
    describedElementList: Array.isArray(parsed.describedElementList)
      ? parsed.describedElementList.filter((element) => typeof element === 'string' && element.trim())
      : [],
  };
}

function parsePageTransitionText(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/g, '').trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const normalized = normalizePageTransition(JSON.parse(jsonMatch[0]));
      if (normalized) return normalized;
    } catch {  }
  }

  const narrMatch = cleaned.match(/"(?:description|narration)"\s*:\s*"([^"]+)"/);
  if (narrMatch) return normalizePageTransition({ description: narrMatch[1] });

  if (!cleaned.includes('{')) {
    const firstLine = cleaned.split(/[\n.]/)[0].trim();
    if (firstLine) return normalizePageTransition({ description: firstLine.slice(0, 40) });
  }
  return null;
}

function createPageTransitionAgent({ config }) {
  async function generate({ jpegBuffer, ts, minWordCount, maxWordCount }) {
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, maxTokens: PAGE_TRANSITION_MAX_TOKENS,
      prompt: buildPageTransitionPrompt({ minWordCount, maxWordCount }),
    });
    const narration = parsePageTransitionText(content);
    if (!narration) throw new Error(`VLM(${AGENT_LABEL}) 응답 파싱 실패 (ts=${ts})`);

    return {
      ...narration,
      pageTopic: truncateToWordCount({ text: narration.pageTopic, maxWordCount }),
    };
  }

  return { generate };
}

module.exports = {
  createPageTransitionAgent, buildPageTransitionPrompt, parsePageTransitionText,
  SCREEN_TYPE_LIST,
};
