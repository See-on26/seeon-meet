const { NARRATION_TYPE_MAP, PAGE_TRANSITION_KIND_MAP } = require('../contracts/narration-types');
const {
  getSlotList, truncateSlot, normalizeSlotMap, DESCRIPTION_TAIL_NOUN_LIST, hasCompleteTailNoun, countWord,
  isWithinEnglishSlotLimit, scaleWordBudget,
} = require('./shared/narration-format');
const { truncateToWordCount, containsHanCharacter } = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const {
  buildPageTransitionPrompt, SCREEN_TYPE_LIST, DEFAULT_TRANSITION_MIN_WORD_COUNT, DEFAULT_TRANSITION_MAX_WORD_COUNT,
} = require('../prompts/page-transition');
const { CAPTION_LANGUAGE_MAP, DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');

const AGENT_LABEL = '전환';
const PAGE_TRANSITION_MAX_TOKENS = 220;

function includesScreenForm({ description, screenForm, language = DEFAULT_CAPTION_LANGUAGE }) {
  const isEnglish = language === CAPTION_LANGUAGE_MAP.en;
  const toComparable = (text) => (isEnglish ? String(text || '').toLowerCase() : String(text || ''));
  const wordList = toComparable(screenForm).split(/\s+/).filter((word) => word.length >= 2);
  return !wordList.length || wordList.some((word) => toComparable(description).includes(word));
}

// 영어 묘사는 한국어 자료 명사로 끝맺었는지 볼 수 없다. 대신 상한(+허용치)을 넘겨 잘라야 하는 묘사를 미완결로 본다 —
// 영어 구는 중간에서 자르면 뜻이 무너지므로, 한국어처럼 한 번 짧게 다시 묻고 그래도 길면 버린다.
function isDescriptionComplete({ rawDescription, descriptionText, descriptionSlot, language }) {
  if (language === CAPTION_LANGUAGE_MAP.en) {
    return isWithinEnglishSlotLimit({ text: rawDescription, maxWordCount: descriptionSlot.maxWordCount });
  }
  return hasCompleteTailNoun({ text: descriptionText });
}

function normalizePageTransition(parsed, { language = DEFAULT_CAPTION_LANGUAGE } = {}) {
  const description = typeof parsed?.description === 'string' && parsed.description.trim()
    ? parsed.description : parsed?.narration;
  if (!parsed || typeof description !== 'string' || !description.trim()) return null;
  const screenType = SCREEN_TYPE_LIST.includes(parsed.screenType) ? parsed.screenType : 'etc';
  const subKind = screenType === 'ppt'
    ? PAGE_TRANSITION_KIND_MAP.slide : PAGE_TRANSITION_KIND_MAP.document;
  const slotList = getSlotList({
    narrationType: NARRATION_TYPE_MAP.pageTransition, subKind, language,
  });
  const descriptionSlot = slotList.find((slot) => slot.key === 'description');

  const descriptionText = normalizeSlotMap({
    slotList: [descriptionSlot], rawSlotMap: { description }, language,
  }).description;
  const screenFormSlot = slotList.find((slot) => slot.key === 'screenForm');
  const screenForm = screenFormSlot
    ? truncateSlot({ text: parsed.screenForm || '', maxWordCount: screenFormSlot.maxWordCount })
    : '';
  const isTailComplete = isDescriptionComplete({
    rawDescription: description, descriptionText, descriptionSlot, language,
  });
  // 한자가 섞인 전환 해설은 읽지 못하므로 고지하지 않는다(caption-parser containsHanCharacter 참고).
  const hasHan = containsHanCharacter(descriptionText) || containsHanCharacter(screenForm);
  const isUsable = isTailComplete && !hasHan;
  return {
    screenType,
    pageNumber: Number.isFinite(parsed.pageNumber) ? Number(parsed.pageNumber) : null,
    pageTopic: typeof parsed.pageTopic === 'string' ? parsed.pageTopic : '',
    isPhotoOnly: parsed.isPhotoOnly === true,
    screenForm,
    description: isUsable ? descriptionText : '',
    rejectedDescription: isUsable ? '' : descriptionText,
    rejectedRawDescription: isUsable ? '' : description.trim(),
    rejectedReason: hasHan ? 'han' : (isTailComplete ? null : 'incomplete'),
    subKind,
    // 머리말("슬라이드 N:"·"페이지:")은 orchestrator 가 붙인다. PPT 가 아닌 화면은 묘사가 화면 형태로 끝나게 지시하지만,
    // 형태를 빠뜨리면("…논문 본문") 형태를 앞에 붙여 무슨 화면인지 잃지 않게 한다.
    narration: !isUsable ? '' : (subKind === PAGE_TRANSITION_KIND_MAP.slide
      || includesScreenForm({ description: descriptionText, screenForm, language })
      ? descriptionText
      : `${screenForm}, ${descriptionText}`),
    describedElementList: Array.isArray(parsed.describedElementList)
      ? parsed.describedElementList.filter((element) => typeof element === 'string' && element.trim())
      : [],
  };
}

function parsePageTransitionText(text, { language = DEFAULT_CAPTION_LANGUAGE } = {}) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/g, '').trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const normalized = normalizePageTransition(JSON.parse(jsonMatch[0]), { language });
      if (normalized) return normalized;
    } catch {  }
  }

  const narrMatch = cleaned.match(/"(?:description|narration)"\s*:\s*"([^"]+)"/);
  if (narrMatch) return normalizePageTransition({ description: narrMatch[1] }, { language });

  if (!cleaned.includes('{')) {
    const firstLine = cleaned.split(/[\n.]/)[0].trim();
    if (firstLine) return normalizePageTransition({ description: firstLine.slice(0, 40) }, { language });
  }
  return null;
}

// 묘사가 길면 자료 명사 앞에서 잘려 버려진다. 그때만 앞 답을 보여 주고 한 번 짧게 다시 묻는다.
function buildRetryLine({ rawDescription, maxWordCount, language = DEFAULT_CAPTION_LANGUAGE }) {
  if (language === CAPTION_LANGUAGE_MAP.en) {
    return `The description in your previous answer, "${rawDescription}", is ${countWord({ text: rawDescription })} words — too long.`
      + ` Rewrite the same screen in at most ${maxWordCount} words, ending with the material type (slide, chart, table, map, etc.).`;
  }
  return `앞 답의 묘사 "${rawDescription}"는 ${countWord({ text: rawDescription })}어절로 길다.`
    + ` 같은 화면을 ${maxWordCount}어절 이내로, 자료 명사(슬라이드·그래프·표·지도 등)로 끝나게 다시 써라.`;
}

function createPageTransitionAgent({ config, getCaptionLanguage = () => DEFAULT_CAPTION_LANGUAGE }) {
  async function requestNarration({ jpegBuffer, ts, prompt, language }) {
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, maxTokens: PAGE_TRANSITION_MAX_TOKENS, prompt,
    });
    const narration = parsePageTransitionText(content, { language });
    if (!narration) throw new Error(`VLM(${AGENT_LABEL}) 응답 파싱 실패 (ts=${ts})`);
    return narration;
  }

  async function generate({ jpegBuffer, ts, minWordCount, maxWordCount, language = getCaptionLanguage() }) {
    // 렌더러의 어절 예산을 캡션 언어의 단어 수로 바꾼다(영어는 상한을 ENGLISH_WORD_SCALE 배로, 한국어는 그대로). 받지 못한 값은 기본 범위를 바꾼다.
    if (language !== DEFAULT_CAPTION_LANGUAGE) {
      ({ minWordCount, maxWordCount } = scaleWordBudget({
        minWordCount: minWordCount ?? DEFAULT_TRANSITION_MIN_WORD_COUNT, maxWordCount: maxWordCount ?? DEFAULT_TRANSITION_MAX_WORD_COUNT, language,
      }));
    }
    const prompt = buildPageTransitionPrompt({ minWordCount, maxWordCount, language });
    const first = await requestNarration({ jpegBuffer, ts, prompt, language });
    let narration = first;
    let isRetried = false;
    if (first.rejectedReason === 'incomplete' && first.rejectedRawDescription) {
      const retryLine = buildRetryLine({
        rawDescription: first.rejectedRawDescription, maxWordCount: maxWordCount ?? DEFAULT_TRANSITION_MAX_WORD_COUNT, language,
      });
      const retried = await requestNarration({
        jpegBuffer, ts, prompt: `${prompt}\n\n${retryLine}`, language,
      }).catch(() => null);
      if (retried?.narration) {
        narration = retried;
        isRetried = true;
      }
    }

    return {
      ...narration,
      isRetried,
      pageTopic: truncateToWordCount({ text: narration.pageTopic, maxWordCount }),
    };
  }

  return { generate };
}

module.exports = {
  createPageTransitionAgent, buildPageTransitionPrompt, parsePageTransitionText,
  SCREEN_TYPE_LIST,
};
