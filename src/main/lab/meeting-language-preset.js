// 실행마다 고르는 회의 언어(ASR 언어). viewer 는 회의 언어를 페이지를 불러올 때 localStorage 에서 한 번 읽고
// 캡처 시작 때 main 에 넘긴다. 그래서 viewer 를 새로 불러오기 전에 preload 가 이 키에 써 넣어야 이번 실행에 실린다.
const { ASR_LANGUAGE_LIST, DEFAULT_ASR_LANGUAGE, isAsrLanguage } = require('../caption-pipeline/config');

// meeting-language-store.js 의 MEETING_LANGUAGE_STORAGE_KEY·MEETING_LANGUAGE_LABEL_MAP. 렌더러 ESM 을 main 에서
// 불러올 수 없어 값만 옮겨 두고, 같은 값인지는 lab-asr-language 테스트가 대조한다.
const MEETING_LANGUAGE_STORAGE_KEY = 'seeon.meetingLanguage';
const LAB_ASR_LANGUAGE_LIST = ASR_LANGUAGE_LIST;
const DEFAULT_LAB_ASR_LANGUAGE = DEFAULT_ASR_LANGUAGE;
const LAB_ASR_LANGUAGE_LABEL_MAP = { ko: '한국어', en: 'English', auto: '자동(한·영)' };

// 자동 실행 환경 변수의 회의 언어. 없으면 기본(한국어), 고를 수 없는 값이면 알리고 기본으로 돌린다.
function readAsrLanguageOption({ value, envName, onWarn = (message) => console.warn(message) }) {
  const language = String(value ?? '').trim();
  if (!language) return DEFAULT_LAB_ASR_LANGUAGE;
  if (isAsrLanguage(language)) return language;
  onWarn(`[lab] ${envName}="${language}" 은 고를 수 없는 회의 언어다 — ${DEFAULT_LAB_ASR_LANGUAGE} 로 돌린다 (허용: ${LAB_ASR_LANGUAGE_LIST.join('·')})`);
  return DEFAULT_LAB_ASR_LANGUAGE;
}

function applyMeetingLanguagePreset({ storage, language }) {
  if (!storage || !isAsrLanguage(language)) return false;
  storage.setItem(MEETING_LANGUAGE_STORAGE_KEY, language);
  return true;
}

module.exports = {
  MEETING_LANGUAGE_STORAGE_KEY, LAB_ASR_LANGUAGE_LIST, DEFAULT_LAB_ASR_LANGUAGE, LAB_ASR_LANGUAGE_LABEL_MAP,
  isLabAsrLanguage: isAsrLanguage, readAsrLanguageOption, applyMeetingLanguagePreset,
};
