const { readContentSwitch } = require('./agents/shared/content-switch');

const DEFAULT_VLM_URL = 'http://127.0.0.1:8801/v1/chat/completions';

const DEFAULT_VLM_MODEL = 'gemma-4-26b-a4b-qat';
const DEFAULT_ASR_URL = 'http://127.0.0.1:8802/asr';
const DEFAULT_TTS_URL = 'http://127.0.0.1:8803/tts';

const DEFAULT_TTS_LONG_URL = 'http://127.0.0.1:8803/tts-long';
const DEFAULT_EMBED_URL = 'http://127.0.0.1:8804/embed';
// 슬라이드 전사 백엔드. ocr 은 임베딩 서비스(같은 GPU 서버 프로세스)의 /ocr 로 화면 글자를 읽어 VLM 호출을 줄인다.
const SLIDE_TEXT_BACKEND_LIST = ['vlm', 'ocr'];
const DEFAULT_SLIDE_TEXT_BACKEND = 'vlm';
// 수치 해설(변화·비교, 값→의미)과 척도 해설에 그 요청 프레임의 OCR 글자를 근거로 넣는다. 「화면 글자 읽기」(전사 백엔드)와 따로 켠다.
const SCREEN_TEXT_GROUNDING_LIST = ['on', 'off'];
const DEFAULT_SCREEN_TEXT_GROUNDING = 'on';
// 교차 모드 틈 후보 위치: asr = ASR 조각 끝 시각(지금 동작), audio = 앱이 잰 회의 소리의 무음 구간.
const GAP_SOURCE_LIST = ['asr', 'audio'];
const DEFAULT_GAP_SOURCE = 'asr';
// 탐지 단계 LLM 판정 전용 서버. GPU 서버에서 VLM(8801)과 같은 모델(Gemma 4 26B-A4B)을 8805 에 따로 띄운다.
const DEFAULT_JUDGE_GPU_URL = 'http://127.0.0.1:8805/v1/chat/completions';
const DEFAULT_JUDGE_GPU_MODEL = 'gemma-4-26b-a4b-qat';
const DEFAULT_BEDROCK_REGION = 'us-east-1';

const DEFAULT_BEDROCK_MODEL_ID = 'anthropic.claude-sonnet-5';

const DEFAULT_ROUTER_MODE = 'unified';

const DEFAULT_SUMMARY_MODEL_ID = 'anthropic.claude-opus-4-7';


// ASR 전사 언어. auto 는 GPU 서버가 ko·en 중 감지 확률이 높은 쪽으로 전사한다.
// 회의·질문 모두 기본 자동이다(사용자가 고르는 것은 캡션 언어뿐). 실험·평가는 환경변수나 세션 시작 값으로 고정할 수 있다.
const ASR_LANGUAGE_LIST = ['ko', 'en', 'auto'];
const DEFAULT_ASR_LANGUAGE = 'auto';

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

// 탐지 단계 LLM 판정(통합 라우터·무발화·지시 판정)의 백엔드. gpu 는 GPU 서버 LLM 만 쓰고 실패해도 Bedrock 으로 넘기지 않는다, bedrock 은 Bedrock 만 쓴다.
const JUDGE_BACKEND_LIST = ['gpu', 'bedrock'];
const DEFAULT_JUDGE_BACKEND = 'gpu';

function readJudgeBackend({ env }) {
  const backend = env.SEEON_JUDGE_BACKEND;
  if (backend === undefined || backend === '') return DEFAULT_JUDGE_BACKEND;
  if (JUDGE_BACKEND_LIST.includes(backend)) return backend;
  console.warn(`[pipeline] SEEON_JUDGE_BACKEND="${backend}" 은 지원하지 않는 판정 백엔드입니다 — ${DEFAULT_JUDGE_BACKEND} 로 판정합니다 (허용: ${JUDGE_BACKEND_LIST.join('·')})`);
  return DEFAULT_JUDGE_BACKEND;
}

function readSlideTextBackend({ env }) {
  const backend = env.SEEON_SLIDE_TEXT_BACKEND;
  if (backend === undefined || backend === '') return DEFAULT_SLIDE_TEXT_BACKEND;
  if (SLIDE_TEXT_BACKEND_LIST.includes(backend)) return backend;
  console.warn(`[pipeline] SEEON_SLIDE_TEXT_BACKEND="${backend}" 은 지원하지 않는 전사 백엔드입니다 — ${DEFAULT_SLIDE_TEXT_BACKEND} 로 전사합니다 (허용: ${SLIDE_TEXT_BACKEND_LIST.join('·')})`);
  return DEFAULT_SLIDE_TEXT_BACKEND;
}

function readScreenTextGrounding({ env }) {
  const mode = env.SEEON_SCREEN_TEXT_GROUNDING;
  if (mode === undefined || mode === '') return DEFAULT_SCREEN_TEXT_GROUNDING;
  if (SCREEN_TEXT_GROUNDING_LIST.includes(mode)) return mode;
  console.warn(`[pipeline] SEEON_SCREEN_TEXT_GROUNDING="${mode}" 은 지원하지 않는 값입니다 — ${DEFAULT_SCREEN_TEXT_GROUNDING} 로 둡니다 (허용: ${SCREEN_TEXT_GROUNDING_LIST.join('·')})`);
  return DEFAULT_SCREEN_TEXT_GROUNDING;
}

// 설정 화면에서 고른 값(회의마다 넘어온다)을 쓰고, 없거나 모르는 값이면 .env 로 정한 값을 쓴다.
function resolveSlideTextBackend({ requested, fallback }) {
  return SLIDE_TEXT_BACKEND_LIST.includes(requested) ? requested : fallback;
}

function readGapSource({ env }) {
  const source = env.SEEON_GAP_SOURCE;
  if (source === undefined || source === '') return DEFAULT_GAP_SOURCE;
  if (GAP_SOURCE_LIST.includes(source)) return source;
  console.warn(`[pipeline] SEEON_GAP_SOURCE="${source}" 은 지원하지 않는 틈 후보 출처입니다 — ${DEFAULT_GAP_SOURCE} 로 찾습니다 (허용: ${GAP_SOURCE_LIST.join('·')})`);
  return DEFAULT_GAP_SOURCE;
}

// VLM 이 그림 한 장을 나눌 이미지 토큰 수 상한(해상도). 비우면 요청에 넣지 않아 서버에 띄운 값(--mm-processor-kwargs)을 쓴다.
// 요청마다 바꾸려면 서버가 --trust-request-mm-kwargs 로 떠 있어야 한다.
function readVlmMaxSoftTokens({ env }) {
  const value = env.SEEON_VLM_MAX_SOFT_TOKENS;
  if (value === undefined || value === '') return null;
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  console.warn(`[pipeline] SEEON_VLM_MAX_SOFT_TOKENS="${value}" 은 양의 정수가 아닙니다 — 요청에 넣지 않고 서버 기본값을 씁니다`);
  return null;
}

// OCR 은 임베딩 서비스에 붙어 있어 기본 주소를 임베딩 주소에서 만든다. 포트를 나누면 SEEON_OCR_URL 로 준다.
function resolveOcrUrl({ env, embedUrl }) {
  if (env.SEEON_OCR_URL) return env.SEEON_OCR_URL;
  try {
    return `${new URL(embedUrl).origin}/ocr`;
  } catch {
    return '';
  }
}

function readPipelineConfig(env = process.env) {
  const bedrockModelId = env.SEEON_BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL_ID;
  const judgeModelId = env.SEEON_BEDROCK_JUDGE_MODEL_ID || bedrockModelId;
  const vlmUrl = env.SEEON_VLM_URL || DEFAULT_VLM_URL;
  const vlmModel = env.SEEON_VLM_MODEL || DEFAULT_VLM_MODEL;
  const embedUrl = env.SEEON_EMBED_URL || DEFAULT_EMBED_URL;
  return {
    vlmUrl,
    vlmModel,
    vlmMaxSoftTokens: readVlmMaxSoftTokens({ env }),
    asrUrl: env.SEEON_ASR_URL || DEFAULT_ASR_URL,
    // 회의 음성과 마이크 질문은 말하는 사람이 달라 언어를 따로 둔다(둘 다 기본 자동).
    asrLanguage: readAsrLanguage({ env, envName: 'SEEON_ASR_LANGUAGE' }),
    questionAsrLanguage: readAsrLanguage({ env, envName: 'SEEON_QUESTION_ASR_LANGUAGE' }),
    ttsUrl: env.SEEON_TTS_URL || DEFAULT_TTS_URL,
    ttsLongUrl: env.SEEON_TTS_LONG_URL || DEFAULT_TTS_LONG_URL,
    embedUrl,
    slideTextBackend: readSlideTextBackend({ env }),
    isScreenTextGroundingEnabled: readScreenTextGrounding({ env }) === 'on',
    gapSource: readGapSource({ env }),
    ocrUrl: resolveOcrUrl({ env, embedUrl }),
    bedrockRegion: env.SEEON_BEDROCK_REGION || DEFAULT_BEDROCK_REGION,
    bedrockModelId,
    bedrockApiKey: env.AWS_BEARER_TOKEN_BEDROCK || '',
    judgeModelId,
    // 판정 GPU LLM 은 VLM 과 같은 모델을 8805 에 따로 띄운 것이고 글만 보낸다. 실패해도 Bedrock 으로 넘기지 않는다.
    // judgeModelId 는 판정 백엔드를 bedrock 으로 골랐을 때 쓴다. 삽입 위치 추론은 판정 백엔드와 상관없이 이 GPU LLM 을 쓴다.
    judgeBackend: readJudgeBackend({ env }),
    judgeGpuUrl: env.SEEON_JUDGE_GPU_URL || DEFAULT_JUDGE_GPU_URL,
    judgeGpuModel: env.SEEON_JUDGE_GPU_MODEL || DEFAULT_JUDGE_GPU_MODEL,
    summaryModelId: env.SEEON_BEDROCK_SUMMARY_MODEL_ID || DEFAULT_SUMMARY_MODEL_ID,
    // 회의 요약 마무리 재구성(듣는 글) — Sonnet. Opus 요약 초안을 낭독용으로 다듬는다.
    summaryRewriteModelId: env.SEEON_BEDROCK_SUMMARY_REWRITE_MODEL_ID || bedrockModelId,
    routerMode: env.SEEON_ROUTER_MODE || DEFAULT_ROUTER_MODE,
    // 추상적 척도 해설(화면에 보이는 대상의 정도)은 기본으로 켠다. 'false' 로 두면 척도 후보를 생성하지 않는다.
    isScaleEnabled: env.SEEON_ROUTER_SCALE_ENABLED !== 'false',
    // 지시·수치·척도 해설 내용 개선 항목별 스위치(기본 켜짐). 항목과 환경변수 이름은 content-switch.js.
    contentSwitch: readContentSwitch(env),
    hasBedrockCredentials:
      Boolean(env.AWS_BEARER_TOKEN_BEDROCK)
      || Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
      || Boolean(env.AWS_PROFILE),
  };
}

module.exports = {
  readPipelineConfig, DEFAULT_JUDGE_GPU_URL, DEFAULT_JUDGE_GPU_MODEL, ASR_LANGUAGE_LIST, DEFAULT_ASR_LANGUAGE, isAsrLanguage, JUDGE_BACKEND_LIST, DEFAULT_JUDGE_BACKEND,
  SLIDE_TEXT_BACKEND_LIST, DEFAULT_SLIDE_TEXT_BACKEND, resolveSlideTextBackend, GAP_SOURCE_LIST, DEFAULT_GAP_SOURCE,
  SCREEN_TEXT_GROUNDING_LIST, DEFAULT_SCREEN_TEXT_GROUNDING,
};
