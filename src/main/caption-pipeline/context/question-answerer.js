const { parseGroundingText, computeMaxChars, GROUNDING_NONE_TOKEN } = require('../agents/shared/caption-parser');
const { QUESTION_ROUTE_MAP } = require('./question-classifier');
const {
  NEED_IMAGE_TOKEN, formatUtteranceLine, buildSlideEvidence, buildPastSlideAnswerPrompt,
  buildImageAnswerPrompt, buildSpeakerAnswerPrompt, buildNarrationReplayPrompt, buildMeetingFlowPrompt,
} = require('../prompts/question-answer');

const NOT_FOUND_TEXT = '화면과 발화에 없는 내용이에요';
const NO_IMAGE_TEXT = '그 화면의 그림 정보는 남아 있지 않아요';
const SPEAKER_UNKNOWN_TEXT = '지금 말하는 사람을 확인하지 못했어요';

const ANSWER_MAX_TOKENS = 300;
const SPEAKER_WINDOW_MS = 10 * 60 * 1000;
const SPEAKER_UTTERANCE_LIMIT = 40;
const NARRATION_REPLAY_LIMIT = 10;
const FLOW_UTTERANCE_PER_SLIDE = 3;
const FLOW_UTTERANCE_MAX_CHARS = 80;

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
      prompt: buildPastSlideAnswerPrompt({ questionText, evidenceText, ...wordBudget }),
      label: '질문 답(지난 화면)', maxTokens: ANSWER_MAX_TOKENS,
    });
    if (!String(content ?? '').trim().startsWith(NEED_IMAGE_TOKEN)) return toAnswer({ content, wordBudget });
    const imagePath = slideList[0].imagePath;
    const jpegBuffer = imagePath ? await readImage(imagePath) : null;
    if (!jpegBuffer) return { text: NO_IMAGE_TEXT, isGrounded: true, isImageUsed: false };
    const imageContent = await requestImage({
      jpegBuffer,
      prompt: buildImageAnswerPrompt({ questionText, evidenceText, ...wordBudget }),
      label: '질문 답(지난 화면 이미지)', maxTokens: ANSWER_MAX_TOKENS,
    });
    return { ...toAnswer({ content: imageContent, wordBudget }), isImageUsed: true };
  }

  async function answerSpeaker({ slideMajorList, questionText, wordBudget }) {
    const utteranceList = slideMajorList.length
      ? slideMajorList.flatMap((slideMajor) => contextStore.getUtteranceList({ slideMajor }))
      : contextStore.getUtteranceList({ fromTs: now() - SPEAKER_WINDOW_MS });
    const utteranceText = utteranceList.slice(-SPEAKER_UTTERANCE_LIMIT)
      .map((utterance) => formatUtteranceLine({ utterance, startedAt: getStartedAt() }))
      .join('\n');
    const content = await requestText({
      prompt: buildSpeakerAnswerPrompt({ questionText, utteranceText, ...wordBudget }),
      label: '질문 답(화자)', maxTokens: ANSWER_MAX_TOKENS,
    });
    return toAnswer({ content, wordBudget });
  }

  async function answerNarrationReplay({ questionText }) {
    const narrationList = contextStore.getNarrationList({ limit: NARRATION_REPLAY_LIMIT });
    if (!narrationList.length) return notFound();
    const content = String(await requestText({
      prompt: buildNarrationReplayPrompt({ questionText, narrationList }),
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
        `[슬라이드 ${entry.major}] ${entry.title}${entry.summary ? ` — ${entry.summary}` : ''}`,
        utteranceText ? `  오간 말: ${utteranceText}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n');
    const content = await requestText({
      prompt: buildMeetingFlowPrompt({ questionText, flowText, ...wordBudget }),
      label: '질문 답(회의 흐름)', maxTokens: ANSWER_MAX_TOKENS,
    });
    return toAnswer({ content, wordBudget });
  }

  async function answer({ route, slideMajorList = [], questionText, wordBudget, speakerHintNow = null }) {
    if (route === QUESTION_ROUTE_MAP.speakerNow) {
      return {
        text: speakerHintNow ? `${speakerHintNow}님이 말하고 있어요` : SPEAKER_UNKNOWN_TEXT,
        isGrounded: true, isImageUsed: false,
      };
    }
    if (route === QUESTION_ROUTE_MAP.pastSlide) return answerPastSlide({ slideMajorList, questionText, wordBudget });
    if (route === QUESTION_ROUTE_MAP.speaker) return answerSpeaker({ slideMajorList, questionText, wordBudget });
    if (route === QUESTION_ROUTE_MAP.narrationReplay) return answerNarrationReplay({ questionText });
    if (route === QUESTION_ROUTE_MAP.meetingFlow) return answerMeetingFlow({ questionText, wordBudget });
    return notFound();
  }

  return { answer };
}

module.exports = { createQuestionAnswerer, NOT_FOUND_TEXT, NO_IMAGE_TEXT, SPEAKER_UNKNOWN_TEXT };
