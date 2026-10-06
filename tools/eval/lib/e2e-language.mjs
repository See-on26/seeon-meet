// 문항 셋의 영상 언어(videoList[].language)와 결과 폴더의 회의 언어(run.json.asrLanguage)가 맞는지 본다.
// 영어 영상을 ko 로 전사한 결과 폴더는 A·S·H·C 조건의 전사가 모두 영상 언어가 아니다.

// 회의 언어를 고르기 전의 실험실은 GPU ASR 이 한국어로만 전사했다. run.json 에 asrLanguage 가 없으면 그 실행이다.
export const LEGACY_ASR_LANGUAGE = 'ko';
// 말하는 조각마다 ko·en 중 하나로 전사하므로 어느 영상 언어와도 맞는 것으로 본다.
export const AUTO_ASR_LANGUAGE = 'auto';

const ASR_LANGUAGE_LABEL_MAP = { ko: '한국어', en: 'English' };

// isLanguageMismatch: 다르면 true, 맞으면 false, 영상 언어가 없거나 run.json 을 못 읽어 모르면 null.
export function judgeRunAsrLanguage({ videoLanguage, runJson }) {
  const isLegacyAsrLanguage = Boolean(runJson) && typeof runJson.asrLanguage !== 'string';
  const asrLanguage = runJson ? (isLegacyAsrLanguage ? LEGACY_ASR_LANGUAGE : runJson.asrLanguage) : null;
  const isJudgeable = typeof videoLanguage === 'string' && videoLanguage !== '' && asrLanguage !== null;
  return {
    videoLanguage: videoLanguage ?? null,
    asrLanguage,
    isLegacyAsrLanguage,
    isLanguageMismatch: isJudgeable ? asrLanguage !== AUTO_ASR_LANGUAGE && asrLanguage !== videoLanguage : null,
  };
}

const formatAsrLanguage = ({ asrLanguage, isLegacyAsrLanguage }) => `${asrLanguage}${isLegacyAsrLanguage ? '(언어 지정 전 실행)' : ''}`;

export function describeAsrLanguageMismatch(judgement) {
  const { videoLanguage } = judgement;
  const choiceLabel = ASR_LANGUAGE_LABEL_MAP[videoLanguage] || videoLanguage;
  return `영상 언어 ${videoLanguage} · 전사 언어 ${formatAsrLanguage(judgement)} — 영상과 다른 언어로 전사해 A·S·H·C 전사가 영향을 받는다.`
    + ` 실험 창에서 회의 언어를 ${choiceLabel} 또는 자동(한·영)으로 골라 다시 돌린다`;
}

// 보고서 결과 폴더 상태 표의 전사 언어 칸.
export function formatRunAsrLanguageCell({ asrLanguage, isLegacyAsrLanguage, videoLanguage }) {
  const asrText = asrLanguage === null || asrLanguage === undefined
    ? '모름' : `${asrLanguage}${isLegacyAsrLanguage ? ' (언어 지정 전)' : ''}`;
  return `${asrText}${videoLanguage ? ` · 영상 ${videoLanguage}` : ''}`;
}

// 보고서 머리의 전사 언어 줄. 영상 언어와 다르게 전사한 결과 폴더가 없으면 줄을 내지 않는다.
export function buildAsrLanguageLineList(runStatusMap = {}) {
  const mismatchList = Object.entries(runStatusMap).filter(([, status]) => status.isLanguageMismatch === true);
  if (!mismatchList.length) return [];
  const itemText = mismatchList.map(([videoId, status]) => `${videoId}(영상 ${status.videoLanguage} · 전사 ${status.asrLanguage}`
    + `${status.isLegacyAsrLanguage ? ', 언어 지정 전 실행' : ''})`).join(', ');
  return [`전사 언어 주의: 영상 언어와 다른 언어로 전사한 결과 폴더가 있다 — ${itemText}. 그 영상의 A·S·H·C 전사는 영상 언어가 아니다.`];
}
