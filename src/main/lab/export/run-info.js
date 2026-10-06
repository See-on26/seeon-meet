const path = require('path');
const { LAB_MODE_LABEL_MAP } = require('../lab-mode');

// 모델 이름과 엔드포인트만 남긴다. 토큰·키 같은 비밀값은 목록에 없어서 실리지 않는다.
const MODEL_CONFIG_KEY_LIST = [
  'vlmUrl', 'vlmModel', 'asrUrl', 'ttsUrl', 'ttsLongUrl', 'embedUrl', 'bedrockRegion', 'bedrockModelId', 'judgeModelId',
  'summaryModelId', 'summaryRewriteModelId', 'gapModelByModeMap', 'routerMode', 'isScaleEnabled', 'isVlmFallbackEnabled',
  'vlmFallbackModelId', 'hasBedrockCredentials',
];

const ENDPOINT_KEY_LIST = ['vlmUrl', 'asrUrl', 'ttsUrl', 'ttsLongUrl', 'embedUrl'];

// 엔드포인트 주소에 사용자 정보(user:password@)나 쿼리·조각(?token=…)이 붙어 있으면 떼고 남긴다.
function toEndpointUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return value;
  }
  if (!url.username && !url.password && !url.search && !url.hash) return value;
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function pickModelConfig(config) {
  const source = config || {};
  return Object.fromEntries(MODEL_CONFIG_KEY_LIST.filter((key) => key in source).map((key) => [
    key, ENDPOINT_KEY_LIST.includes(key) ? toEndpointUrl(source[key]) : source[key],
  ]));
}

const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// asrLanguage 는 고른 회의 언어, asrLanguageApplied 는 그 언어가 실제로 실렸는지의 근거다(export/asr-language.js).
function buildRunInfo({ run, modelConfig, captureStartWallMs, adTiming, countMap, errorList, isComplete, asrLanguageApplied = null }) {
  return {
    runId: run.runId,
    videoPath: run.videoPath,
    videoName: path.basename(run.videoPath || ''),
    videoDurationMs: run.videoInfo?.durationMs ?? null,
    videoWidth: run.videoInfo?.videoWidth ?? null,
    videoHeight: run.videoInfo?.videoHeight ?? null,
    mode: run.mode,
    modeLabel: LAB_MODE_LABEL_MAP[run.mode] || null,
    isEvalPreset: run.isEvalPreset,
    featureToggleMap: run.featureToggleMap,
    asrLanguage: run.asrLanguage ?? null,
    asrLanguageApplied,
    layout: run.layout,
    playerViewport: run.videoInfo?.viewport ?? null,
    roiNormRect: run.roiNormRect,
    git: run.git,
    // 호출하는 쪽이 원본 파이프라인 설정을 넘겨도 비밀값이 run.json 에 실리지 않게 여기서 한 번 더 고른다.
    modelConfig: pickModelConfig(modelConfig),
    startedAt: toIso(run.startedAtMs),
    endedAt: toIso(run.endedAtMs),
    sessionId: run.sessionId,
    recordPath: run.recordPath,
    captureRequestedWallMs: run.captureRequestedWallMs,
    captureStartWallMs,
    outputStartWallMs: run.outputStartWallMs,
    playStartWallMs: run.playStartWallMs,
    videoEndedWallMs: run.videoEndedWallMs,
    adTiming,
    counts: countMap,
    errorList,
    isComplete,
  };
}

module.exports = { buildRunInfo, pickModelConfig, MODEL_CONFIG_KEY_LIST };
