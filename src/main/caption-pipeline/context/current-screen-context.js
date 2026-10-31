const { buildSlideEvidence } = require('../prompts/question-answer');

// '지금 화면' 질문의 기록 재료. 최근 60초 받아쓰기는 발표가 길면 앞 설명이 빠지므로,
// 이 슬라이드가 떠 있는 동안 쌓인 말 전부(시각·화자)와 들려준 해설을 넣는다. 말이 길면 오래된 말부터 뺀다.
const CURRENT_SCREEN_UTTERANCE_MAX_CHARS = 6000;

function buildCurrentScreenContextText({ contextStore, major }) {
  const slide = major === null || major === undefined ? null : contextStore.getSlide(major);
  if (!slide) return '';
  return buildSlideEvidence({
    slide,
    utteranceList: contextStore.getUtteranceList({ slideMajor: major }),
    narrationList: contextStore.getNarrationList({ limit: Infinity }).filter((narration) => narration.slideMajor === major),
    startedAt: contextStore.getSessionInfo().startedAt,
    utteranceLimit: Infinity,
    utteranceMaxChars: CURRENT_SCREEN_UTTERANCE_MAX_CHARS,
  });
}

module.exports = { buildCurrentScreenContextText, CURRENT_SCREEN_UTTERANCE_MAX_CHARS };
