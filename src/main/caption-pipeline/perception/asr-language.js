const { isAsrLanguage, ASR_LANGUAGE_LIST } = require('../config');

// 회의 음성과 마이크 질문의 ASR 언어를 따로 들고 요청에 실어 보낸다.
// 둘 다 기본 자동이다. 회의 언어는 실험·평가에서 세션마다 고정할 수 있고, 질문 언어는 설정값(SEEON_QUESTION_ASR_LANGUAGE)을 쓴다.
function createAsrLanguageSession({ asrClient, config }) {
  let meetingLanguage = config.asrLanguage;

  // 요청을 보낸 시점의 언어를 결과에 남긴다. 응답을 기다리는 동안 언어가 바뀌어도 기록이 어긋나지 않는다.
  async function transcribeWithLanguage({ webmBuffer, startTs, language }) {
    const result = await asrClient.transcribeSegment({ webmBuffer, startTs, language });
    return { ...result, requestedLanguage: language };
  }

  return {
    getMeetingLanguage: () => meetingLanguage,
    getQuestionLanguage: () => config.questionAsrLanguage,
    setMeetingLanguage(language) {
      if (!isAsrLanguage(language)) {
        console.warn(`[pipeline] ASR 언어 "${language}" 은 지원하지 않습니다 — ${meetingLanguage} 를 그대로 씁니다 (허용: ${ASR_LANGUAGE_LIST.join('·')})`);
        return false;
      }
      meetingLanguage = language;
      return true;
    },
    transcribeMeetingSegment: ({ webmBuffer, startTs }) => transcribeWithLanguage({
      webmBuffer, startTs, language: meetingLanguage,
    }),
    transcribeQuestionSegment: ({ webmBuffer, startTs }) => transcribeWithLanguage({
      webmBuffer, startTs, language: config.questionAsrLanguage,
    }),
  };
}

// 캡처 시작 때 렌더러가 고른 회의 언어를 적용하고, 이번 세션에 쓸 회의 언어를 돌려준다.
// 언어를 보내지 않는 옛 호출이면 지금 회의 언어를 그대로 쓴다. 허용값이 아니면 setMeetingLanguage 가 경고하고 그대로 둔다.
function applySessionMeetingLanguage({ asrLanguageSession, asrLanguage }) {
  if (asrLanguage !== undefined && asrLanguage !== null) asrLanguageSession.setMeetingLanguage(asrLanguage);
  return asrLanguageSession.getMeetingLanguage();
}

module.exports = { createAsrLanguageSession, applySessionMeetingLanguage };
