// viewer localStorage 'seeon.featureToggles' 에 페이지 스크립트보다 먼저 써 넣을 값.
// 평가 설정(회의록 3.2.1): 페이지 전환 안내·화자 안내·회의 요약을 끈다. 지시·발화·무발화는 항상 동작한다.
const FEATURE_TOGGLE_STORAGE_KEY = 'seeon.featureToggles';

const EVAL_PRESET_MAP = { page_transition: false, speaker_identity: false, meeting_summary: false };
const PRODUCT_DEFAULT_MAP = { page_transition: true, speaker_identity: true, meeting_summary: true };

function buildFeatureTogglePreset({ isEvalPreset }) {
  return { ...(isEvalPreset ? EVAL_PRESET_MAP : PRODUCT_DEFAULT_MAP) };
}

function applyFeatureTogglePreset({ storage, presetMap }) {
  if (!storage || !presetMap) return false;
  storage.setItem(FEATURE_TOGGLE_STORAGE_KEY, JSON.stringify(presetMap));
  return true;
}

module.exports = { FEATURE_TOGGLE_STORAGE_KEY, buildFeatureTogglePreset, applyFeatureTogglePreset };
