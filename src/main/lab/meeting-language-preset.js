// 실행마다 고르는 두 언어.
// - 받아쓰기 언어(ASR 언어): 제품 화면은 보내지 않는다(제품 회의 받아쓰기는 늘 자동). 실험 viewer preload 가
//   세션 시작 요청(startPipelineSession)에 이번 실행의 값을 덧붙여 main 에 넘긴다.
// - 캡션 언어: 들리는 말(자동 AD·질문 답·고정 안내·TTS·회의 요약)과 화면 글자의 언어. viewer 는 페이지를 불러올 때
//   localStorage 에서 한 번 읽어 세션 시작 때 넘기므로, viewer 를 새로 불러오기 전에 preload 가 이 키에 써 넣는다.
const { ASR_LANGUAGE_LIST, isAsrLanguage } = require('../caption-pipeline/config');
const { CAPTION_LANGUAGE_LIST, isCaptionLanguage } = require('../caption-pipeline/contracts/caption-language');

const LAB_ASR_LANGUAGE_LIST = ASR_LANGUAGE_LIST;
// 평가 영상이 한국어라 실험은 제품 기본(자동)과 달리 받아쓰기를 한국어로 고정해 두고 시작한다.
const DEFAULT_LAB_ASR_LANGUAGE = 'ko';
const LAB_ASR_LANGUAGE_LABEL_MAP = { ko: '한국어', en: 'English', auto: '자동(한·영)' };

// caption-language-store.js 의 CAPTION_LANGUAGE_STORAGE_KEY·CAPTION_LANGUAGE_LABEL_MAP. 렌더러 ESM 을 main 에서
// 불러올 수 없어 값만 옮겨 두고, 같은 값인지는 lab-asr-language 테스트가 대조한다.
const CAPTION_LANGUAGE_STORAGE_KEY = 'seeon.captionLanguage';
const LAB_CAPTION_LANGUAGE_LIST = CAPTION_LANGUAGE_LIST;
// 평가 영상이 한국어라 실험은 캡션도 한국어를 기본으로 둔다.
const DEFAULT_LAB_CAPTION_LANGUAGE = 'ko';
const LAB_CAPTION_LANGUAGE_LABEL_MAP = { ko: '한국어', en: 'English' };

// 자동 실행 환경 변수의 언어. 없으면 기본, 고를 수 없는 값이면 알리고 기본으로 돌린다.
function readLanguageOption({ value, envName, kindText, isAllowed, languageList, defaultLanguage, onWarn }) {
  const language = String(value ?? '').trim();
  if (!language) return defaultLanguage;
  if (isAllowed(language)) return language;
  onWarn(`[lab] ${envName}="${language}" 은 고를 수 없는 ${kindText}다 — ${defaultLanguage} 로 돌린다 (허용: ${languageList.join('·')})`);
  return defaultLanguage;
}

function readAsrLanguageOption({ value, envName, onWarn = (message) => console.warn(message) }) {
  return readLanguageOption({
    value, envName, kindText: '받아쓰기 언어', isAllowed: isAsrLanguage,
    languageList: LAB_ASR_LANGUAGE_LIST, defaultLanguage: DEFAULT_LAB_ASR_LANGUAGE, onWarn,
  });
}

function readCaptionLanguageOption({ value, envName, onWarn = (message) => console.warn(message) }) {
  return readLanguageOption({
    value, envName, kindText: '캡션 언어', isAllowed: isCaptionLanguage,
    languageList: LAB_CAPTION_LANGUAGE_LIST, defaultLanguage: DEFAULT_LAB_CAPTION_LANGUAGE, onWarn,
  });
}

function applyCaptionLanguagePreset({ storage, language }) {
  if (!storage || !isCaptionLanguage(language)) return false;
  storage.setItem(CAPTION_LANGUAGE_STORAGE_KEY, language);
  return true;
}

module.exports = {
  LAB_ASR_LANGUAGE_LIST, DEFAULT_LAB_ASR_LANGUAGE, LAB_ASR_LANGUAGE_LABEL_MAP, isLabAsrLanguage: isAsrLanguage, readAsrLanguageOption,
  CAPTION_LANGUAGE_STORAGE_KEY, LAB_CAPTION_LANGUAGE_LIST, DEFAULT_LAB_CAPTION_LANGUAGE, LAB_CAPTION_LANGUAGE_LABEL_MAP,
  isLabCaptionLanguage: isCaptionLanguage, readCaptionLanguageOption, applyCaptionLanguagePreset,
};
