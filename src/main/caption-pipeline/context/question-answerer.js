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

// 모델이 토큰 대신 "기록에 명시되어 있지 않습니다" 같은 설명으로 못 찾았다고 답하는 경우.
// 숫자가 든 답("날짜는 알 수 없지만 500만원…")은 답이 있는 것으로 본다.
// 영어 답이면 "not mentioned"·"cannot find" 같은 거절 문장을 대소문자 없이 본다.
const NOT_FOUND_PHRASE_PATTERN = new RegExp([
  '명시되어 있지 않', '나와 있지 않', '알 수 없', '확인할 수 없', '찾을 수 없', '기록에 없', '기록에는 없',
  'not mentioned', 'not found', 'no information', 'cannot find', "can't find", 'can not find', 'not shown',
  'not stated', 'not specified', 'not in the record',
].join('|'), 'i');
const TOKEN_WRAPPER_PATTERN = /^[\s"'`*「『“]+/;

// 교차 모드는 사용자가 회의를 늦게 듣는다. 이만큼 늦으면 '지금 화자'를 실시간 화면이 아니라 들은 시점 발화로 정한다.
const HEARD_LAG_THRESHOLD_MS = 2000;
const HEARD_SPEAKER_WINDOW_MS = 8000;

function toAnswer({ content, wordBudget, language = DEFAULT_CAPTION_LANGUAGE }) {
  const { text, isGrounded } = parseGroundingText(
    content, computeMaxChars({ maxWordCount: wordBudget.maxWordCount, language }), wordBudget.maxWordCount, language,
  );
  return isGrounded ? { text, isGrounded: true, isImageUsed: false } : notFound({ language });
}

function notFound({ language = DEFAULT_CAPTION_LANGUAGE } = {}) {
  return { text: readAnswerText({ key: ANSWER_TEXT_KEY_MAP.notFound, language }), isGrounded: false, isImageUsed: false };
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
      || (NOT_FOUND_PHRASE_PATTERN.test(trimmed) && !/\d/.test(trimmed));
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
};
