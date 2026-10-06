const DEFAULT_VLM_URL = 'http://127.0.0.1:8801/v1/chat/completions';

const DEFAULT_VLM_MODEL = 'qwen3.5-35b-a3b';
const DEFAULT_ASR_URL = 'http://127.0.0.1:8802/asr';
const DEFAULT_TTS_URL = 'http://127.0.0.1:8803/tts';

const DEFAULT_TTS_LONG_URL = 'http://127.0.0.1:8803/tts-long';
const DEFAULT_EMBED_URL = 'http://127.0.0.1:8804/embed';
// 탐지 단계 경량 LLM 판정 전용 서버. GPU 서버에서 VLM(8801)과 따로 Qwen3.5-9B 를 8805 에 띄운다.
const DEFAULT_JUDGE_GPU_URL = 'http://127.0.0.1:8805/v1/chat/completions';
const DEFAULT_JUDGE_GPU_MODEL = 'qwen3.5-9b';
const DEFAULT_BEDROCK_REGION = 'us-east-1';

const DEFAULT_BEDROCK_MODEL_ID = 'anthropic.claude-sonnet-5';

const DEFAULT_ROUTER_MODE = 'unified';

const DEFAULT_SUMMARY_MODEL_ID = 'anthropic.claude-opus-4-7';

const DEFAULT_GAP_QUALITY_MODEL_ID = 'anthropic.claude-opus-4-7';

// GPU VLM 이 응답하지 못할 때 같은 프롬프트·이미지를 보낼 Bedrock 모델. ensureUsPrefix 가 us. 를 붙인다.
const DEFAULT_VLM_FALLBACK_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';

// ASR 전사 언어. auto 는 GPU 서버가 ko·en 중 감지 확률이 높은 쪽으로 전사한다.
const ASR_LANGUAGE_LIST = ['ko', 'en', 'auto'];
const DEFAULT_ASR_LANGUAGE = 'ko';

function isAsrLanguage(language) {
  return ASR_LANGUAGE_LIST.includes(language);
}

function readAsrLanguage({ env, envName }) {
  const language = env[envName];
  if (language === undefined || language === '') return DEFAULT_ASR_LANGUAGE;
  if (isAsrLanguage(language)) return language;
  console.warn(`[pipeline] ${envName}="${language}" 은 지원하지 않는 ASR 언어입니다 — ${DEFAULT_ASR_LANGUAGE} 로 전사합니다 (허용: ${ASR_LANGUAGE_LIST.join('·')})`);
  return DEFAULT_ASR_LANGUAGE;
}

// 탐지 단계 경량 LLM 판정(통합 라우터·무발화·지시 판정)의 백엔드. gpu 는 GPU 서버 LLM 을 먼저 쓰고 실패하면 Bedrock 으로 넘긴다.
const JUDGE_BACKEND_LIST = ['gpu', 'bedrock'];
const DEFAULT_JUDGE_BACKEND = 'gpu';

function readJudgeBackend({ env }) {
  const backend = env.SEEON_JUDGE_BACKEND;
  if (backend === undefined || backend === '') return DEFAULT_JUDGE_BACKEND;
  if (JUDGE_BACKEND_LIST.includes(backend)) return backend;
  console.warn(`[pipeline] SEEON_JUDGE_BACKEND="${backend}" 은 지원하지 않는 판정 백엔드입니다 — ${DEFAULT_JUDGE_BACKEND} 로 판정합니다 (허용: ${JUDGE_BACKEND_LIST.join('·')})`);
  return DEFAULT_JUDGE_BACKEND;
}

function readPipelineConfig(env = process.env) {
  const bedrockModelId = env.SEEON_BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL_ID;
  const judgeModelId = env.SEEON_BEDROCK_JUDGE_MODEL_ID || bedrockModelId;
  const vlmUrl = env.SEEON_VLM_URL || DEFAULT_VLM_URL;
  const vlmModel = env.SEEON_VLM_MODEL || DEFAULT_VLM_MODEL;
  return {
    vlmUrl,
    vlmModel,
    asrUrl: env.SEEON_ASR_URL || DEFAULT_ASR_URL,
    // 회의 음성과 마이크 질문(한국어 사용자)은 말하는 사람이 달라 언어를 따로 둔다.
    asrLanguage: readAsrLanguage({ env, envName: 'SEEON_ASR_LANGUAGE' }),
    questionAsrLanguage: readAsrLanguage({ env, envName: 'SEEON_QUESTION_ASR_LANGUAGE' }),
    ttsUrl: env.SEEON_TTS_URL || DEFAULT_TTS_URL,
    ttsLongUrl: env.SEEON_TTS_LONG_URL || DEFAULT_TTS_LONG_URL,
    embedUrl: env.SEEON_EMBED_URL || DEFAULT_EMBED_URL,
    bedrockRegion: env.SEEON_BEDROCK_REGION || DEFAULT_BEDROCK_REGION,
    bedrockModelId,
    bedrockApiKey: env.AWS_BEARER_TOKEN_BEDROCK || '',
    judgeModelId,
    // 판정 GPU LLM 은 VLM 과 따로 띄운 경량 모델(Qwen3.5-9B)에 글만 보낸다. Bedrock judgeModelId 는 GPU 실패 때 폴백이다.
    judgeBackend: readJudgeBackend({ env }),
    judgeGpuUrl: env.SEEON_JUDGE_GPU_URL || DEFAULT_JUDGE_GPU_URL,
    judgeGpuModel: env.SEEON_JUDGE_GPU_MODEL || DEFAULT_JUDGE_GPU_MODEL,
    summaryModelId: env.SEEON_BEDROCK_SUMMARY_MODEL_ID || DEFAULT_SUMMARY_MODEL_ID,
    // 회의 요약 마무리 재구성(듣는 글) — Sonnet. Opus 요약 초안을 낭독용으로 다듬는다.
    summaryRewriteModelId: env.SEEON_BEDROCK_SUMMARY_REWRITE_MODEL_ID || bedrockModelId,
    // 삽입 위치 추론(SIC)만 모드별로 모델을 나눈다. 품질=Opus, 균형=Sonnet(=judge 재사용).
    // 성능·동시 모드는 delayMs=0이라 삽입 위치 추론을 호출하지 않는다.
    gapModelByModeMap: {
      listening: env.SEEON_BEDROCK_GAP_QUALITY_MODEL_ID || DEFAULT_GAP_QUALITY_MODEL_ID,
      delayed: env.SEEON_BEDROCK_GAP_BALANCED_MODEL_ID || judgeModelId,
    },
    routerMode: env.SEEON_ROUTER_MODE || DEFAULT_ROUTER_MODE,
    // 추상적 척도 해설(화면에 보이는 대상의 정도)은 기본으로 켠다. 'false' 로 두면 척도 후보를 생성하지 않는다.
    isScaleEnabled: env.SEEON_ROUTER_SCALE_ENABLED !== 'false',
    isVlmFallbackEnabled: env.SEEON_VLM_FALLBACK_ENABLED !== 'false',
    vlmFallbackModelId: env.SEEON_BEDROCK_VLM_FALLBACK_MODEL_ID || DEFAULT_VLM_FALLBACK_MODEL_ID,
    hasBedrockCredentials:
      Boolean(env.AWS_BEARER_TOKEN_BEDROCK)
      || Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
      || Boolean(env.AWS_PROFILE),
  };
}

module.exports = {
  readPipelineConfig, DEFAULT_JUDGE_GPU_URL, DEFAULT_JUDGE_GPU_MODEL, ASR_LANGUAGE_LIST, DEFAULT_ASR_LANGUAGE, isAsrLanguage, JUDGE_BACKEND_LIST, DEFAULT_JUDGE_BACKEND,
};
