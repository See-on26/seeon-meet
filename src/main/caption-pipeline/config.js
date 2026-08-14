const DEFAULT_VLM_URL = 'http://127.0.0.1:8801/v1/chat/completions';

const DEFAULT_VLM_MODEL = 'qwen3.5-35b-a3b';
const DEFAULT_ASR_URL = 'http://127.0.0.1:8802/asr';
const DEFAULT_TTS_URL = 'http://127.0.0.1:8803/tts';

const DEFAULT_TTS_LONG_URL = 'http://127.0.0.1:8803/tts-long';
const DEFAULT_EMBED_URL = 'http://127.0.0.1:8804/embed';
const DEFAULT_BEDROCK_REGION = 'us-east-1';

const DEFAULT_BEDROCK_MODEL_ID = 'anthropic.claude-sonnet-5';

const DEFAULT_ROUTER_MODE = 'unified';

const DEFAULT_SUMMARY_MODEL_ID = 'anthropic.claude-opus-4-7';

const DEFAULT_GAP_QUALITY_MODEL_ID = 'anthropic.claude-opus-4-7';

function readPipelineConfig(env = process.env) {
  const bedrockModelId = env.SEEON_BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL_ID;
  const judgeModelId = env.SEEON_BEDROCK_JUDGE_MODEL_ID || bedrockModelId;
  return {
    vlmUrl: env.SEEON_VLM_URL || DEFAULT_VLM_URL,
    vlmModel: env.SEEON_VLM_MODEL || DEFAULT_VLM_MODEL,
    asrUrl: env.SEEON_ASR_URL || DEFAULT_ASR_URL,
    ttsUrl: env.SEEON_TTS_URL || DEFAULT_TTS_URL,
    ttsLongUrl: env.SEEON_TTS_LONG_URL || DEFAULT_TTS_LONG_URL,
    embedUrl: env.SEEON_EMBED_URL || DEFAULT_EMBED_URL,
    bedrockRegion: env.SEEON_BEDROCK_REGION || DEFAULT_BEDROCK_REGION,
    bedrockModelId,
    bedrockApiKey: env.AWS_BEARER_TOKEN_BEDROCK || '',
    judgeModelId,
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
    hasBedrockCredentials:
      Boolean(env.AWS_BEARER_TOKEN_BEDROCK)
      || Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
      || Boolean(env.AWS_PROFILE),
  };
}

module.exports = { readPipelineConfig };
