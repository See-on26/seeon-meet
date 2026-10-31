const { parseGroundingText, computeMaxChars, GROUNDING_NONE_TOKEN } = require('../agents/shared/caption-parser');
const { scaleWordBudget } = require('../agents/shared/narration-format');
const { QUESTION_ROUTE_MAP } = require('./question-classifier');
const { formatHeardSlideTag } = require('./slide-tag');
const { formatQaHistory } = require('./qa-history');
const {
  NEED_IMAGE_TOKEN, formatUtteranceLine, buildSlideEvidence, buildPastSlideAnswerPrompt,
  buildImageAnswerPrompt, buildSpeakerAnswerPrompt, buildNarrationReplayPrompt, buildMeetingFlowPrompt,
} = require('../prompts/question-answer');
const { CAPTION_LANGUAGE_MAP, DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');

const NOT_FOUND_TEXT = '화면과 발화에 없는 내용이에요';
const NO_IMAGE_TEXT = '그 화면의 그림 정보는 남아 있지 않아요';
const SPEAKER_UNKNOWN_TEXT = '지금 말하는 사람을 확인하지 못했어요';
// 회의와 관계없는 질문(정치·날씨·일반 상식 등)은 화면·발화를 뒤지지 않고 이 문구로 답한다.
const OFF_TOPIC_TEXT = '회의와 관련된 질문에만 답할 수 있어요';

// 질문 답의 고정 문구. 캡션 언어가 영어면 영어 문구로 답한다. 위 한국어 상수는 그대로 내보낸다.
const ANSWER_TEXT_KEY_MAP = {
  notFound: 'notFound', noImage: 'noImage', speakerUnknown: 'speakerUnknown', offTopic: 'offTopic',
};
const ANSWER_TEXT_MAP = {
  [CAPTION_LANGUAGE_MAP.ko]: {
    [ANSWER_TEXT_KEY_MAP.notFound]: NOT_FOUND_TEXT,
    [ANSWER_TEXT_KEY_MAP.noImage]: NO_IMAGE_TEXT,
    [ANSWER_TEXT_KEY_MAP.speakerUnknown]: SPEAKER_UNKNOWN_TEXT,
    [ANSWER_TEXT_KEY_MAP.offTopic]: OFF_TOPIC_TEXT,
  },
  [CAPTION_LANGUAGE_MAP.en]: {
    [ANSWER_TEXT_KEY_MAP.notFound]: 'That is not on the screen or in what was said',
    [ANSWER_TEXT_KEY_MAP.noImage]: 'No picture of that screen was saved',
    [ANSWER_TEXT_KEY_MAP.speakerUnknown]: 'I could not tell who is speaking right now',
    [ANSWER_TEXT_KEY_MAP.offTopic]: 'I can only answer questions about this meeting',
  },
};

function readAnswerText({ key, language = DEFAULT_CAPTION_LANGUAGE }) {
  return (ANSWER_TEXT_MAP[language] || ANSWER_TEXT_MAP[DEFAULT_CAPTION_LANGUAGE])[key];
}

function buildSpeakerNowText({ speaker, language = DEFAULT_CAPTION_LANGUAGE }) {
  return language === CAPTION_LANGUAGE_MAP.en ? `${speaker} is speaking` : `${speaker}님이 말하고 있어요`;
}

const ANSWER_MAX_TOKENS = 300;
const SPEAKER_WINDOW_MS = 10 * 60 * 1000;
const SPEAKER_UTTERANCE_LIMIT = 40;
const NARRATION_REPLAY_LIMIT = 10;
const FLOW_UTTERANCE_PER_SLIDE = 3;
const FLOW_UTTERANCE_MAX_CHARS = 80;

// 지난 화면 답에서 모델이 토큰 대신 "기록에 명시되어 있지 않습니다" 같은 설명으로 못 찾았다고 답하는 경우. 저장해 둔 화면 그림을 다시 볼지 정한다.
// 숫자가 든 답("날짜는 알 수 없지만 500만원…")은 답이 있는 것으로 본다.
// 영어 답이면 "not mentioned"·"cannot find" 같은 거절 문장을 대소문자 없이 본다.
const NOT_FOUND_PHRASE_PATTERN = new RegExp([
  '명시되어 있지 않', '나와 있지 않', '알 수 없', '확인할 수 없', '찾을 수 없', '기록에 없', '기록에는 없',
  'not mentioned', 'not found', 'no information', 'cannot find', "can't find", 'can not find', 'not shown',
  'not stated', 'not specified', 'not in the record',
].join('|'), 'i');
const DIGIT_PATTERN = /\d/;

// 답 전체가 못 찾았다는 말인지 문장마다 본다. "단위는 나와 있지 않아요"처럼 내용을 말하면서 일부만 없다고 하거나,
// "보이지 않는 위협"처럼 거절 말이 명사 앞 꼴로 들어간 진짜 답은 바꾸지 않는다.
const SENTENCE_SPLIT_PATTERN = /(?<=[.!?。])\s+|\n+/;
const SENTENCE_TRIM_PATTERN = /^[\s"'`*「『“]+|[\s"'`*」』”.!?。…~]+$/g;
// 답 전체가 따옴표 한 쌍으로 싸여 있으면 화면 글자를 옮긴 것이다("요청하신 페이지를 찾을 수 없습니다").
const QUOTED_ANSWER_PATTERN = /^(?:["“「『][^"“”「」『』]*["”」』]|'[^']*'|‘[^‘’]*’)[.!?。]?$/;
// 앞머리 사과는 떼고 본다("죄송하지만 그 정보는 …", "Sorry, I couldn't …").
const APOLOGY_PREFIX_PATTERN = /^(?:(?:죄송하지만|죄송합니다만|미안하지만|아쉽게도)\s*,?|죄송(?:합니다|해요)\s*,|(?:(?:i'm |i am )?sorry|unfortunately)\s*,\s*(?:but\s+)?)\s*/i;
// 사과만 하는 문장은 거절 문장 앞뒤에 붙어도 답 내용으로 보지 않는다.
const APOLOGY_SENTENCE_PATTERN = /^(?:죄송(?:합니다|해요)|미안(?:합니다|해요)|(?:i'm |i am )?sorry|unfortunately)$/i;
// 쉼표·따옴표·이음말이 있으면 앞에 내용 있는 절이 있거나 남의 말을 옮긴 것이라 거절 문장으로 보지 않는다.
// 장소의 "에서·여기서", "만으로·자료로"는 이음말 "-서·-로"로 보지 않는다. 작은따옴표는 영어 축약(couldn't)과 헷갈려 띄어쓰기 뒤에 열 때만 본다.
const CONTENT_CLAUSE_PATTERN = new RegExp('[,;:"“”「」『』]|\\s[\'‘]'
  + '|(?:지만|는데|은데|인데|이고|있고|없고|하고|되고|[았었였했]고|며|(?<![에기])서|라|(?<!만으|자료)로)\\s'
  + '|(?:말|말씀|설명)(?:로는|으로는)|에\\s*따르면'
  + '|\\b(?:but|although|though|however|while|and|because|since|said|says|told|explained)\\b', 'i');
// 정보가 없다는 술어 앞에 말이 길면 사람 모습 같은 내용을 말한 뒤 일부만 모른다는 답이다.
// 장소·지시어("화면과 발화에서", "해당")를 뺀 앞말이 이만큼 어절 이하일 때만 거절로 본다.
const KO_PREFIX_MAX_WORD_COUNT = 2;
const KO_PREFIX_FILLER_PATTERN = /^(?:(?:(?:화면|자료|슬라이드|발화|기록|회의|발표|대화)(?:과|와|이나|나|에|에는|에서|에서는|엔|만으로|만으로는)?)|현재|지금|지금은|제시된|주어진|해당|관련|그|이|그건|이건|그것은|여기|여기서|아직|잘)$/;
const EN_PREFIX_MAX_WORD_COUNT = 4;
const KO_ENDING = '(?:았|었)?(?:습니다|어요|아요|네요|다|음)';
// 무엇이 어디에 있든 정보가 없다는 뜻인 술어(명시·언급·기록·찾기·알기).
const KO_META_REFUSAL_PATTERN = new RegExp('(?:(?:명시|기재|언급)(?:되어|돼)\\s*있지\\s*않|언급(?:되|하)지\\s*않|언급(?:이|은|도)\\s*없'
  + '|(?:알|확인할|찾을|파악할)\\s*수(?:가|는)?\\s*없|찾지\\s*못(?:했|하)|기록(?:에|에는|엔)\\s*없|모르겠)' + KO_ENDING + '$');
// 화면에 보이는지를 말하는 술어. "그래프에는 증가 추세가 보이지 않아요" 같은 진짜 답에도 쓰여서,
// 정보를 가리키는 말이 주어로 오거나 장소 바로 뒤에 술어만 올 때만 거절로 본다.
const KO_VISUAL_REFUSAL = '(?:(?:(?:나와|포함되어|포함돼|표시되어|표시돼|적혀|나타나|제시되어|제시돼|담겨)\\s*있지\\s*않'
  + '|(?:나오|보이|드러나|확인되)지\\s*않|없)' + KO_ENDING + '|안\\s*(?:나와|보여)(?:\\s*있어)?요)';
const KO_VISUAL_REFUSAL_PATTERN = new RegExp(KO_VISUAL_REFUSAL + '$');
const KO_INFO_SUBJECT_PATTERN = new RegExp('(?:^|\\s)(?:(?:해당|관련|그|이|그런|이런)\\s*)?(?:정보|내용)(?:은|는|이|가|도)\\s'
  + '|(?:해당|관련|그|이|그런|이런)\\s*(?:항목|부분|수치|값|자료)(?:은|는|이|가|도)\\s|^(?:그건|그것은|그것도|이건)\\s');
const KO_WH_SUBJECT_PATTERN = /(?:인지|는지|은지)(?:는|도)?\s/;
const KO_PLACE = '(?:(?:제시된|현재|지금|이|그)\\s*)?(?:화면|자료|슬라이드|발화|기록|회의|발표|대화)(?:과\\s*발화|이나\\s*발화|나\\s*발화)?'
  + '(?:에|에는|에서|에서는|엔)';
const KO_PLACE_ONLY_REFUSAL_PATTERN = new RegExp('^(?:' + KO_PLACE + '\\s*)?' + KO_VISUAL_REFUSAL + '$');
const KO_NOT_FOUND_CONTENT_PATTERN = /(?:없는|나와\s*있지\s*않은|나오지\s*않은|언급되지\s*않은|포함되지\s*않은|보이지\s*않는)\s*내용(?:이에요|입니다|이다|예요)$/;
const EN_INFO_SUBJECT = '(?:that|this|it|that information|this information|the information|such information|that detail|this detail|the answer|that part)';
const EN_NOT_BE = "(?:is|was|are|were)(?:\\s+not|n't)";
const EN_NOT_DO = "(?:does|did|do)(?:\\s+not|n't)";
const EN_SHOWN = '(?:shown|visible|displayed|included|listed|provided|given|available|mentioned|stated|specified|recorded|found'
  + '|on (?:the|this) (?:screen|slide)|in (?:the|this) (?:slide|screen|record|transcript|meeting))';
const EN_REFUSAL_PATTERN_LIST = [
  new RegExp('^' + EN_INFO_SUBJECT + '\\s+' + EN_NOT_BE + '\\s+' + EN_SHOWN + '\\b'),
  new RegExp('^' + EN_INFO_SUBJECT + '\\s+' + EN_NOT_DO + '\\s+(?:appear|show up|show)\\b'),
  new RegExp('^(?:the )?(?:slide|screen|transcript|record|presentation|speaker|presenter)\\s+' + EN_NOT_DO
    + '\\s+(?:mention|say|state|specify|include)\\b'),
  new RegExp('^not\\s+' + EN_SHOWN + '\\b'),
  /^i\s+(?:could not|couldn't|cannot|can't|can not|did not|didn't)\s+find\b/,
  /^(?:there is|there's|there was|there are)\s+no\s+(?:information|mention|record|data|details?)\b/,
  /^no\s+(?:information|mention|record|details?)\b/,
];
// 언급·명시·기록 여부는 주어와 상관없이 정보가 없다는 뜻이다("The amount is not mentioned in the record"). 주어가 짧을 때만 본다.
const EN_META_REFUSAL_PATTERN = new RegExp('\\b' + EN_NOT_BE + '\\s+(?:mentioned|stated|specified|recorded)\\b');

function isShortKoPrefix({ sentence, match }) {
  const wordList = sentence.slice(0, match.index).trim().split(/\s+/).filter(Boolean);
  return wordList.filter((word) => !KO_PREFIX_FILLER_PATTERN.test(word)).length <= KO_PREFIX_MAX_WORD_COUNT;
}

function isShortEnPrefix({ sentence, match }) {
  return sentence.slice(0, match.index).trim().split(/\s+/).filter(Boolean).length <= EN_PREFIX_MAX_WORD_COUNT;
}

function isRefusalSentence(sentence) {
  if (CONTENT_CLAUSE_PATTERN.test(sentence)) return false;
  // 정보가 없다는 술어로 끝나면 앞말 길이만으로 정한다("수 없어요"가 보이는지 술어 "없어요"로 다시 걸리지 않게).
  const koMetaMatch = sentence.match(KO_META_REFUSAL_PATTERN);
  if (koMetaMatch) return isShortKoPrefix({ sentence, match: koMetaMatch });
  if (KO_NOT_FOUND_CONTENT_PATTERN.test(sentence)) return true;
  const koVisualMatch = sentence.match(KO_VISUAL_REFUSAL_PATTERN);
  if (koVisualMatch) {
    if (KO_INFO_SUBJECT_PATTERN.test(sentence) || KO_PLACE_ONLY_REFUSAL_PATTERN.test(sentence)) return true;
    // "누구인지는 나와 있지 않아요" 꼴은 앞에 사람 모습 같은 내용이 길게 오지 않을 때만 거절로 본다.
    if (KO_WH_SUBJECT_PATTERN.test(sentence)) return isShortKoPrefix({ sentence, match: koVisualMatch });
  }
  const lowered = sentence.toLowerCase().replace(/\b(that|it|this)'s\b/g, '$1 is');
  const enMetaMatch = lowered.match(EN_META_REFUSAL_PATTERN);
  if (enMetaMatch && isShortEnPrefix({ sentence: lowered, match: enMetaMatch })) return true;
  return EN_REFUSAL_PATTERN_LIST.some((pattern) => pattern.test(lowered));
}

// 숫자 없이 답 전체가 못 찾았다고만 말하는 답인가. 이런 답은 근거 없음으로 보고 고정 문구로 바꾼다.
function isNotFoundAnswerText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed || DIGIT_PATTERN.test(trimmed) || QUOTED_ANSWER_PATTERN.test(trimmed)) return false;
  const sentenceList = trimmed.split(SENTENCE_SPLIT_PATTERN)
    .map((sentence) => sentence.replace(/[’‘]/g, "'").replace(SENTENCE_TRIM_PATTERN, '').replace(APOLOGY_PREFIX_PATTERN, ''))
    .filter(Boolean);
  const contentList = sentenceList.filter((sentence) => !APOLOGY_SENTENCE_PATTERN.test(sentence));
  return contentList.length > 0 && contentList.every(isRefusalSentence);
}
const TOKEN_WRAPPER_PATTERN = /^[\s"'`*「『“]+/;

// 교차 모드는 사용자가 회의를 늦게 듣는다. 이만큼 늦으면 '지금 화자'를 실시간 화면이 아니라 들은 시점 발화로 정한다.
const HEARD_LAG_THRESHOLD_MS = 2000;
const HEARD_SPEAKER_WINDOW_MS = 8000;

function toAnswer({ content, wordBudget, language = DEFAULT_CAPTION_LANGUAGE }) {
  const { text, isGrounded } = parseGroundingText(
    content, computeMaxChars({ maxWordCount: wordBudget.maxWordCount, language }), wordBudget.maxWordCount, language,
  );
  return isGrounded && !isNotFoundAnswerText(text) ? { text, isGrounded: true, isImageUsed: false } : notFound({ language });
}

function notFound({ language = DEFAULT_CAPTION_LANGUAGE } = {}) {
  return { text: readAnswerText({ key: ANSWER_TEXT_KEY_MAP.notFound, language }), isGrounded: false, isImageUsed: false };
}

// 사용자에게 들려줄 질문 답. 근거가 없거나(NONE·빈 답) 비었으면 고정 문구 "화면과 발화에 없는 내용이에요"(영어 캡션이면
// 영어 문구)로 답한다. 앱이 만든 문장(해설 다시 듣기·지금 화자·회의와 무관·그림 없음)과 이미 거른 모델 답은 이것만 거친다.
function resolveGroundedText({ text, isGrounded, language = DEFAULT_CAPTION_LANGUAGE }) {
  if (isGrounded && text) return { text, isGrounded: true };
  return { text: readAnswerText({ key: ANSWER_TEXT_KEY_MAP.notFound, language }), isGrounded: false };
}

// 모델이 화면을 보고 바로 쓴 답(프리셋·현재 화면 질문). 거절 문장으로 답했어도 근거 없음으로 보고 고정 문구로 바꾼다.
function resolveAnswerText({ text, isGrounded, language = DEFAULT_CAPTION_LANGUAGE }) {
  return resolveGroundedText({ text, isGrounded: Boolean(isGrounded) && !isNotFoundAnswerText(text), language });
}

// getCaptionLanguage 는 이번 세션의 캡션 언어다. 답 프롬프트·고정 문구가 이 언어를 따른다.
function createQuestionAnswerer({ requestText, requestImage, readImage, contextStore, now = Date.now,
  getCaptionLanguage = () => DEFAULT_CAPTION_LANGUAGE }) {
  function getStartedAt() {
    return contextStore.getSessionInfo().startedAt;
  }

  // 이번 회의에서 앞서 오간 질문과 답. 지금 질문은 답을 낸 뒤에 쌓이므로 들어가지 않는다.
  function readQaHistoryText() {
    return formatQaHistory({ qaList: contextStore.getQaList(), startedAt: getStartedAt() });
  }

  function buildSlideEvidenceText(slideList) {
    const narrationList = contextStore.getNarrationList({ limit: Infinity });
    return slideList.map((slide) => buildSlideEvidence({
      slide,
      utteranceList: contextStore.getUtteranceList({ slideMajor: slide.major }),
      narrationList: narrationList.filter((narration) => narration.slideMajor === slide.major),
      startedAt: getStartedAt(),
    })).join('\n\n');
  }

  async function answerPastSlide({ slideMajorList, questionText, wordBudget, language }) {
    const slideList = slideMajorList.map((major) => contextStore.getSlide(major)).filter(Boolean);
    if (!slideList.length) return notFound({ language });
    const evidenceText = buildSlideEvidenceText(slideList);
    const content = await requestText({
      prompt: buildPastSlideAnswerPrompt({
        questionText, evidenceText, ...wordBudget, hasImage: Boolean(slideList[0].imagePath),
        qaHistoryText: readQaHistoryText(), language,
      }),
      label: '질문 답(지난 화면)', maxTokens: ANSWER_MAX_TOKENS,
    });
    // 텍스트로 답을 못 찾았으면 저장해 둔 화면 그림에서 다시 찾는다.
    const trimmed = String(content ?? '').trim().replace(TOKEN_WRAPPER_PATTERN, '');
    // 모델이 "기록에 없습니다. NEED_IMAGE"처럼 설명 뒤에 토큰을 붙이기도 한다. 어디에 있든 이미지 재조회로 본다.
    const isImageRequested = trimmed.includes(NEED_IMAGE_TOKEN);
    const isNotFound = new RegExp(`^${GROUNDING_NONE_TOKEN}\\b`, 'i').test(trimmed)
      || (NOT_FOUND_PHRASE_PATTERN.test(trimmed) && !DIGIT_PATTERN.test(trimmed));
    if (!isImageRequested && !isNotFound) return toAnswer({ content, wordBudget, language });
    const imagePath = slideList[0].imagePath;
    const jpegBuffer = imagePath ? await readImage(imagePath) : null;
    if (!jpegBuffer) {
      return isImageRequested
        ? { text: readAnswerText({ key: ANSWER_TEXT_KEY_MAP.noImage, language }), isGrounded: true, isImageUsed: false }
        : notFound({ language });
    }
    const imageContent = await requestImage({
      jpegBuffer,
      prompt: buildImageAnswerPrompt({
        questionText, evidenceText, ...wordBudget, qaHistoryText: readQaHistoryText(), language,
      }),
      label: '질문 답(지난 화면 이미지)', maxTokens: ANSWER_MAX_TOKENS,
    });
    return { ...toAnswer({ content: imageContent, wordBudget, language }), isImageUsed: true };
  }

  async function answerSpeaker({ slideMajorList, questionText, wordBudget, heardWallTs, language }) {
    const toTs = heardWallTs ?? Infinity;
    const utteranceList = slideMajorList.length
      ? slideMajorList.flatMap((slideMajor) => contextStore.getUtteranceList({ slideMajor, toTs }))
      : contextStore.getUtteranceList({ fromTs: (heardWallTs ?? now()) - SPEAKER_WINDOW_MS, toTs });
    const utteranceText = utteranceList.slice(-SPEAKER_UTTERANCE_LIMIT)
      .map((utterance) => formatUtteranceLine({ utterance, startedAt: getStartedAt() }))
      .join('\n');
    const content = await requestText({
      prompt: buildSpeakerAnswerPrompt({
        questionText, utteranceText, ...wordBudget, qaHistoryText: readQaHistoryText(), language,
      }),
      label: '질문 답(화자)', maxTokens: ANSWER_MAX_TOKENS,
    });
    return toAnswer({ content, wordBudget, language });
  }

  // 교차 모드에서 아직 재생되지 않은 해설(원 사건 시각이 들은 위치보다 뒤)은 "방금 해설"이 아니다.
  async function answerNarrationReplay({ questionText, heardVideoTimeMs, language }) {
    const narrationList = contextStore.getNarrationList({ limit: Infinity })
      .filter((narration) => !Number.isFinite(heardVideoTimeMs) || narration.eventVideoTimeMs === null
        || narration.eventVideoTimeMs <= heardVideoTimeMs)
      .slice(-NARRATION_REPLAY_LIMIT);
    if (!narrationList.length) return notFound({ language });
    const content = String(await requestText({
      prompt: buildNarrationReplayPrompt({ questionText, narrationList, qaHistoryText: readQaHistoryText() }),
      label: '질문 답(해설 다시)', maxTokens: 20,
    }) ?? '').trim();
    if (content.startsWith(GROUNDING_NONE_TOKEN)) return notFound({ language });
    const picked = narrationList[Number.parseInt(content, 10) - 1];
    return picked ? { text: picked.text, isGrounded: true, isImageUsed: false } : notFound({ language });
  }

  async function answerMeetingFlow({ questionText, wordBudget, language }) {
    const flowText = contextStore.buildIndex().map((entry) => {
      const utteranceText = contextStore.getUtteranceList({ slideMajor: entry.major })
        .slice(0, FLOW_UTTERANCE_PER_SLIDE)
        .map((utterance) => utterance.text.slice(0, FLOW_UTTERANCE_MAX_CHARS))
        .join(' / ');
      return [
        `[${formatHeardSlideTag({ displayNumber: entry.displayNumber })}] ${entry.title}${entry.summary ? ` — ${entry.summary}` : ''}`,
        utteranceText ? `  오간 말: ${utteranceText}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n');
    const content = await requestText({
      prompt: buildMeetingFlowPrompt({
        questionText, flowText, ...wordBudget, qaHistoryText: readQaHistoryText(), language,
      }),
      label: '질문 답(회의 흐름)', maxTokens: ANSWER_MAX_TOKENS,
    });
    return toAnswer({ content, wordBudget, language });
  }

  function resolveSpeakerNow({ speakerHintNow, heardWallTs }) {
    if (!Number.isFinite(heardWallTs) || now() - heardWallTs <= HEARD_LAG_THRESHOLD_MS) return speakerHintNow;
    const heardList = contextStore.getUtteranceList({
      fromTs: heardWallTs - HEARD_SPEAKER_WINDOW_MS, toTs: heardWallTs,
    }).filter((utterance) => utterance.speakerHint);
    return heardList.length ? heardList[heardList.length - 1].speakerHint : null;
  }

  // heardWallTs·heardVideoTimeMs 는 사용자가 지금 듣고 있는 위치다(교차 모드는 실시간보다 늦다).
  async function answer({ route, slideMajorList = [], questionText, wordBudget, speakerHintNow = null,
    heardWallTs = null, heardVideoTimeMs = null }) {
    const language = getCaptionLanguage();
    // 렌더러의 어절 예산을 캡션 언어의 단어 수로 바꾼다(영어는 상한을 ENGLISH_WORD_SCALE 배로, 한국어는 그대로).
    if (wordBudget) wordBudget = scaleWordBudget({ ...wordBudget, language });
    if (route === QUESTION_ROUTE_MAP.speakerNow) {
      const speaker = resolveSpeakerNow({ speakerHintNow, heardWallTs });
      return {
        text: speaker
          ? buildSpeakerNowText({ speaker, language })
          : readAnswerText({ key: ANSWER_TEXT_KEY_MAP.speakerUnknown, language }),
        isGrounded: true, isImageUsed: false,
      };
    }
    if (route === QUESTION_ROUTE_MAP.pastSlide) return answerPastSlide({ slideMajorList, questionText, wordBudget, language });
    if (route === QUESTION_ROUTE_MAP.speaker) {
      return answerSpeaker({ slideMajorList, questionText, wordBudget, heardWallTs, language });
    }
    if (route === QUESTION_ROUTE_MAP.narrationReplay) {
      return answerNarrationReplay({ questionText, heardVideoTimeMs, language });
    }
    if (route === QUESTION_ROUTE_MAP.meetingFlow) return answerMeetingFlow({ questionText, wordBudget, language });
    if (route === QUESTION_ROUTE_MAP.none) {
      return { text: readAnswerText({ key: ANSWER_TEXT_KEY_MAP.offTopic, language }), isGrounded: true, isImageUsed: false };
    }
    return notFound({ language });
  }

  return { answer };
}

module.exports = {
  createQuestionAnswerer, NOT_FOUND_TEXT, NO_IMAGE_TEXT, SPEAKER_UNKNOWN_TEXT, OFF_TOPIC_TEXT,
  ANSWER_TEXT_KEY_MAP, readAnswerText, buildSpeakerNowText, NOT_FOUND_PHRASE_PATTERN,
  isNotFoundAnswerText, resolveAnswerText, resolveGroundedText,
};
