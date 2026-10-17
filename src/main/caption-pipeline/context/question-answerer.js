const { parseGroundingText, computeMaxChars, GROUNDING_NONE_TOKEN } = require('../agents/shared/caption-parser');
const { QUESTION_ROUTE_MAP } = require('./question-classifier');
const { formatHeardSlideTag } = require('./slide-tag');
const { formatQaHistory } = require('./qa-history');
const {
  NEED_IMAGE_TOKEN, formatUtteranceLine, buildSlideEvidence, buildPastSlideAnswerPrompt,
  buildImageAnswerPrompt, buildSpeakerAnswerPrompt, buildNarrationReplayPrompt, buildMeetingFlowPrompt,
} = require('../prompts/question-answer');

const NOT_FOUND_TEXT = '화면과 발화에 없는 내용이에요';
const NO_IMAGE_TEXT = '그 화면의 그림 정보는 남아 있지 않아요';
const SPEAKER_UNKNOWN_TEXT = '지금 말하는 사람을 확인하지 못했어요';
// 회의와 관계없는 질문(정치·날씨·일반 상식 등)은 화면·발화를 뒤지지 않고 이 문구로 답한다.
const OFF_TOPIC_TEXT = '회의와 관련된 질문에만 답할 수 있어요';

const ANSWER_MAX_TOKENS = 300;
const SPEAKER_WINDOW_MS = 10 * 60 * 1000;
const SPEAKER_UTTERANCE_LIMIT = 40;
const NARRATION_REPLAY_LIMIT = 10;
const FLOW_UTTERANCE_PER_SLIDE = 3;
const FLOW_UTTERANCE_MAX_CHARS = 80;

// 모델이 토큰 대신 "기록에 명시되어 있지 않습니다" 같은 설명으로 못 찾았다고 답하는 경우.
// 숫자가 든 답("날짜는 알 수 없지만 500만원…")은 답이 있는 것으로 본다.
const NOT_FOUND_PHRASE_PATTERN = /(명시되어 있지 않|나와 있지 않|알 수 없|확인할 수 없|찾을 수 없|기록에 없|기록에는 없)/;
const TOKEN_WRAPPER_PATTERN = /^[\s"'`*「『“]+/;

// 교차 모드는 사용자가 회의를 늦게 듣는다. 이만큼 늦으면 '지금 화자'를 실시간 화면이 아니라 들은 시점 발화로 정한다.
const HEARD_LAG_THRESHOLD_MS = 2000;
const HEARD_SPEAKER_WINDOW_MS = 8000;

function toAnswer({ content, wordBudget }) {
  const { text, isGrounded } = parseGroundingText(
    content, computeMaxChars({ maxWordCount: wordBudget.maxWordCount }), wordBudget.maxWordCount,
  );
  return isGrounded ? { text, isGrounded: true, isImageUsed: false } : notFound();
}

function notFound() {
  return { text: NOT_FOUND_TEXT, isGrounded: false, isImageUsed: false };
}

function createQuestionAnswerer({ requestText, requestImage, readImage, contextStore, now = Date.now }) {
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

  async function answerPastSlide({ slideMajorList, questionText, wordBudget }) {
    const slideList = slideMajorList.map((major) => contextStore.getSlide(major)).filter(Boolean);
    if (!slideList.length) return notFound();
    const evidenceText = buildSlideEvidenceText(slideList);
    const content = await requestText({
      prompt: buildPastSlideAnswerPrompt({
        questionText, evidenceText, ...wordBudget, hasImage: Boolean(slideList[0].imagePath),
        qaHistoryText: readQaHistoryText(),
      }),
      label: '질문 답(지난 화면)', maxTokens: ANSWER_MAX_TOKENS,
    });
    // 텍스트로 답을 못 찾았으면 저장해 둔 화면 그림에서 다시 찾는다.
    const trimmed = String(content ?? '').trim().replace(TOKEN_WRAPPER_PATTERN, '');
    // 모델이 "기록에 없습니다. NEED_IMAGE"처럼 설명 뒤에 토큰을 붙이기도 한다. 어디에 있든 이미지 재조회로 본다.
    const isImageRequested = trimmed.includes(NEED_IMAGE_TOKEN);
    const isNotFound = new RegExp(`^${GROUNDING_NONE_TOKEN}\\b`, 'i').test(trimmed)
      || (NOT_FOUND_PHRASE_PATTERN.test(trimmed) && !/\d/.test(trimmed));
    if (!isImageRequested && !isNotFound) return toAnswer({ content, wordBudget });
    const imagePath = slideList[0].imagePath;
    const jpegBuffer = imagePath ? await readImage(imagePath) : null;
    if (!jpegBuffer) {
      return isImageRequested ? { text: NO_IMAGE_TEXT, isGrounded: true, isImageUsed: false } : notFound();
    }
    const imageContent = await requestImage({
      jpegBuffer,
      prompt: buildImageAnswerPrompt({ questionText, evidenceText, ...wordBudget, qaHistoryText: readQaHistoryText() }),
      label: '질문 답(지난 화면 이미지)', maxTokens: ANSWER_MAX_TOKENS,
    });
    return { ...toAnswer({ content: imageContent, wordBudget }), isImageUsed: true };
  }

  async function answerSpeaker({ slideMajorList, questionText, wordBudget, heardWallTs }) {
    const toTs = heardWallTs ?? Infinity;
    const utteranceList = slideMajorList.length
      ? slideMajorList.flatMap((slideMajor) => contextStore.getUtteranceList({ slideMajor, toTs }))
      : contextStore.getUtteranceList({ fromTs: (heardWallTs ?? now()) - SPEAKER_WINDOW_MS, toTs });
    const utteranceText = utteranceList.slice(-SPEAKER_UTTERANCE_LIMIT)
      .map((utterance) => formatUtteranceLine({ utterance, startedAt: getStartedAt() }))
      .join('\n');
    const content = await requestText({
      prompt: buildSpeakerAnswerPrompt({ questionText, utteranceText, ...wordBudget, qaHistoryText: readQaHistoryText() }),
      label: '질문 답(화자)', maxTokens: ANSWER_MAX_TOKENS,
    });
    return toAnswer({ content, wordBudget });
  }

  // 교차 모드에서 아직 재생되지 않은 해설(원 사건 시각이 들은 위치보다 뒤)은 "방금 해설"이 아니다.
  async function answerNarrationReplay({ questionText, heardVideoTimeMs }) {
    const narrationList = contextStore.getNarrationList({ limit: Infinity })
      .filter((narration) => !Number.isFinite(heardVideoTimeMs) || narration.eventVideoTimeMs === null
        || narration.eventVideoTimeMs <= heardVideoTimeMs)
      .slice(-NARRATION_REPLAY_LIMIT);
    if (!narrationList.length) return notFound();
    const content = String(await requestText({
      prompt: buildNarrationReplayPrompt({ questionText, narrationList, qaHistoryText: readQaHistoryText() }),
      label: '질문 답(해설 다시)', maxTokens: 20,
    }) ?? '').trim();
    if (content.startsWith(GROUNDING_NONE_TOKEN)) return notFound();
    const picked = narrationList[Number.parseInt(content, 10) - 1];
    return picked ? { text: picked.text, isGrounded: true, isImageUsed: false } : notFound();
  }

  async function answerMeetingFlow({ questionText, wordBudget }) {
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
      prompt: buildMeetingFlowPrompt({ questionText, flowText, ...wordBudget, qaHistoryText: readQaHistoryText() }),
      label: '질문 답(회의 흐름)', maxTokens: ANSWER_MAX_TOKENS,
    });
    return toAnswer({ content, wordBudget });
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
    if (route === QUESTION_ROUTE_MAP.speakerNow) {
      const speaker = resolveSpeakerNow({ speakerHintNow, heardWallTs });
      return {
        text: speaker ? `${speaker}님이 말하고 있어요` : SPEAKER_UNKNOWN_TEXT,
        isGrounded: true, isImageUsed: false,
      };
    }
    if (route === QUESTION_ROUTE_MAP.pastSlide) return answerPastSlide({ slideMajorList, questionText, wordBudget });
    if (route === QUESTION_ROUTE_MAP.speaker) {
      return answerSpeaker({ slideMajorList, questionText, wordBudget, heardWallTs });
    }
    if (route === QUESTION_ROUTE_MAP.narrationReplay) return answerNarrationReplay({ questionText, heardVideoTimeMs });
    if (route === QUESTION_ROUTE_MAP.meetingFlow) return answerMeetingFlow({ questionText, wordBudget });
    if (route === QUESTION_ROUTE_MAP.none) return { text: OFF_TOPIC_TEXT, isGrounded: true, isImageUsed: false };
    return notFound();
  }

  return { answer };
}

module.exports = { createQuestionAnswerer, NOT_FOUND_TEXT, NO_IMAGE_TEXT, SPEAKER_UNKNOWN_TEXT, OFF_TOPIC_TEXT };
