const { readContentSwitch } = require('./agents/shared/content-switch');
const { SCREEN_CHANGE_KIND_MAP } = require('./contracts/narration-types');

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
// 화면 사실 카드: 새 슬라이드가 확정될 때 VLM 한 번으로 패널별 사실을 만들어 두고, 해설 때 발화와 가까운 카드를 에이전트에 넘긴다.
// 제품 기본은 켜짐이다(off 로 끄면 프롬프트가 카드 없을 때와 같다). 받는 에이전트는 수치·척도가 기본이고, 지시는 따로 켜서 잰다.
const FACT_CARD_SWITCH_LIST = ['on', 'off'];
const DEFAULT_FACT_CARD_SWITCH = 'on';
const FACT_CARD_AGENT_LIST = ['interpretation', 'scale', 'deixis'];
const DEFAULT_FACT_CARD_AGENT_LIST = ['interpretation', 'scale'];
// 카드 JSON 은 프롬프트로만 받는다. vLLM 의 json_schema 출력 모드는 이 서버에서 시험한 적이 없어 받지 않는다.
const FACT_CARD_JSON_MODE_LIST = ['prompt'];
const DEFAULT_FACT_CARD_JSON_MODE = 'prompt';
// 그래프 값 어림(세로 막대·한 계열·값 라벨 없음). 수치 해설 때 근거 OCR 줄과 같은 프레임 화소로 막대 값을 잰다.
// off = 하지 않음, log = 계산해 기록에만 남김(프롬프트·값 검사는 그대로), on = 수치 에이전트에 넘기고 값 검사에서 어림값을 인정.
// 화면 글자 근거(SEEON_SCREEN_TEXT_GROUNDING)가 꺼져 있으면 OCR 줄이 없어 저절로 하지 않는다.
const CHART_ESTIMATE_MODE_MAP = { off: 'off', log: 'log', on: 'on' };
const CHART_ESTIMATE_MODE_LIST = Object.values(CHART_ESTIMATE_MODE_MAP);
const DEFAULT_CHART_ESTIMATE_MODE = CHART_ESTIMATE_MODE_MAP.off;
// 교차 모드 틈 후보 위치: asr = ASR 조각 끝 시각(지금 동작), audio = 앱이 잰 회의 소리의 무음 구간.
const GAP_SOURCE_LIST = ['asr', 'audio'];
const DEFAULT_GAP_SOURCE = 'asr';
// 탐지 단계 LLM 판정 전용 서버. GPU 서버에서 VLM(8801)과 같은 모델(Gemma 4 26B-A4B)을 8805 에 따로 띄운다.
const DEFAULT_JUDGE_GPU_URL = 'http://127.0.0.1:8805/v1/chat/completions';
const DEFAULT_JUDGE_GPU_MODEL = 'gemma-4-26b-a4b-qat';
const DEFAULT_BEDROCK_REGION = 'us-east-1';

const DEFAULT_BEDROCK_MODEL_ID = 'anthropic.claude-sonnet-5';

const DEFAULT_ROUTER_MODE = 'unified';

// 회의 중 닫힌 슬라이드 구간을 미리 요약해 둔다. off 면 회의 중에는 하지 않고 회의 뒤에 모든 구간을 요약한다(실시간 해설에 주는 영향을 견줄 때).
const DEFAULT_SUMMARY_LIVE_SEGMENTS = 'on';


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

function readFactCardSwitch({ env }) {
  const mode = env.SEEON_FACT_CARD;
  if (mode === undefined || mode === '') return DEFAULT_FACT_CARD_SWITCH;
  if (FACT_CARD_SWITCH_LIST.includes(mode)) return mode;
  console.warn(`[pipeline] SEEON_FACT_CARD="${mode}" 은 지원하지 않는 값입니다 — ${DEFAULT_FACT_CARD_SWITCH} 로 둡니다 (허용: ${FACT_CARD_SWITCH_LIST.join('·')})`);
  return DEFAULT_FACT_CARD_SWITCH;
}

function readFactCardAgentList({ env }) {
  const value = env.SEEON_FACT_CARD_AGENTS;
  if (value === undefined || value === '') return [...DEFAULT_FACT_CARD_AGENT_LIST];
  const nameList = [...new Set(value.split(',').map((name) => name.trim()).filter(Boolean))];
  const unknownList = nameList.filter((name) => !FACT_CARD_AGENT_LIST.includes(name));
  if (unknownList.length) {
    console.warn(`[pipeline] SEEON_FACT_CARD_AGENTS 의 ${unknownList.map((name) => `"${name}"`).join(', ')} 은 모르는 에이전트입니다 — 빼고 읽습니다 (허용: ${FACT_CARD_AGENT_LIST.join('·')})`);
  }
  const agentList = nameList.filter((name) => FACT_CARD_AGENT_LIST.includes(name));
  return agentList.length ? agentList : [...DEFAULT_FACT_CARD_AGENT_LIST];
}

function readFactCardJsonMode({ env }) {
  const mode = env.SEEON_FACT_CARD_JSON_MODE;
  if (mode === undefined || mode === '') return DEFAULT_FACT_CARD_JSON_MODE;
  if (FACT_CARD_JSON_MODE_LIST.includes(mode)) return mode;
  console.warn(`[pipeline] SEEON_FACT_CARD_JSON_MODE="${mode}" 은 지원하지 않는 값입니다 — ${DEFAULT_FACT_CARD_JSON_MODE} 로 둡니다 (허용: ${FACT_CARD_JSON_MODE_LIST.join('·')})`);
  return DEFAULT_FACT_CARD_JSON_MODE;
}

function readChartEstimateMode({ env }) {
  const mode = env.SEEON_CHART_ESTIMATE;
  if (mode === undefined || mode === '') return DEFAULT_CHART_ESTIMATE_MODE;
  if (CHART_ESTIMATE_MODE_LIST.includes(mode)) return mode;
  console.warn(`[pipeline] SEEON_CHART_ESTIMATE="${mode}" 은 지원하지 않는 값입니다 — ${DEFAULT_CHART_ESTIMATE_MODE} 로 둡니다 (허용: ${CHART_ESTIMATE_MODE_LIST.join('·')})`);
  return DEFAULT_CHART_ESTIMATE_MODE;
}

// 발화로 ROI 잡기: 발화 낱말을 화면 OCR 줄 위치와 맞춰 그 둘레를 확대하고 해설 요청에 [화면 전체, 확대] 두 장을 넣는다.
// 제품 기본은 켜짐이다(off 로 끄면 요청에 화면 전체 한 장만 넣는다).
const SPEECH_ROI_MODE_LIST = ['on', 'off'];
const DEFAULT_SPEECH_ROI_MODE = 'on';
// 확대를 받을 해설 유형(지시·수치·척도). 회차가 나빠지면 유형별로 떼어 본다.
const SPEECH_ROI_TYPE_LIST = ['deixis', 'interpretation', 'visual_description'];
// 지시 후보만 있는 요청에도 같은 프레임 OCR 을 판단과 함께 시작할지(끝나 있을 때만 쓴다). 기본 꺼짐.
const DEFAULT_SPEECH_ROI_FRAME_OCR = 'off';
// 발화 확대가 없고 가리킨 영역만 있는 지시 해설도 [화면 전체, 가리킨 영역] 두 장으로 줄지. 발화 ROI 가 켜졌을 때만 쓴다.
const DEFAULT_SPEECH_ROI_POINTING_PAIR = 'on';

function readOnOffSwitch({ env, envName, defaultValue }) {
  const value = env[envName];
  if (value === undefined || value === '') return defaultValue;
  if (SPEECH_ROI_MODE_LIST.includes(value)) return value;
  console.warn(`[pipeline] ${envName}="${value}" 은 지원하지 않는 값입니다 — ${defaultValue} 로 둡니다 (허용: ${SPEECH_ROI_MODE_LIST.join('·')})`);
  return defaultValue;
}

function readSpeechRoiTypeList({ env }) {
  const value = env.SEEON_SPEECH_ROI_TYPES;
  if (value === undefined || value === '') return [...SPEECH_ROI_TYPE_LIST];
  const requestedList = value.split(',').map((item) => item.trim()).filter(Boolean);
  const unknownList = requestedList.filter((item) => !SPEECH_ROI_TYPE_LIST.includes(item));
  const typeList = SPEECH_ROI_TYPE_LIST.filter((item) => requestedList.includes(item));
  if (unknownList.length || !typeList.length) {
    console.warn(`[pipeline] SEEON_SPEECH_ROI_TYPES="${value}" 에 지원하지 않는 유형이 있습니다(${unknownList.join('·') || '없음'})`
      + ` — ${typeList.length ? typeList.join(',') : `기본값 ${SPEECH_ROI_TYPE_LIST.join(',')}`} 로 둡니다 (허용: ${SPEECH_ROI_TYPE_LIST.join('·')})`);
  }
  return typeList.length ? typeList : [...SPEECH_ROI_TYPE_LIST];
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

// 같은 슬라이드 안 화면 변화 해설. off 면 감지·OCR·재시도 기록을 하지 않아 지금과 같다.
// shadow 는 감지·OCR 글자 차이·이미 말한 값 거르기까지 하고 기록만 남긴다(VLM·해설 없음). same_slide 는 같은 슬라이드
// 변화 해설과 늦은 근거 재시도를 낸다. all 의 새 슬라이드 값 한 줄은 꺼 둔 전환 고지 자리에 해설을 다시 넣어 평가 조건을 바꾸므로
// 만들지 않았다. all 을 주면 화면 변화 해설은 켜려는 뜻이라 same_slide 로 돌리고, 기록에도 same_slide 로 남긴다.
const SCREEN_CHANGE_MODE_MAP = { off: 'off', shadow: 'shadow', sameSlide: 'same_slide' };
const SCREEN_CHANGE_MODE_ALL = 'all';
const SCREEN_CHANGE_MODE_LIST = Object.values(SCREEN_CHANGE_MODE_MAP);
// 제품 기본은 same_slide 다.
const DEFAULT_SCREEN_CHANGE_MODE = SCREEN_CHANGE_MODE_MAP.sameSlide;
// 변화 해설끼리의 간격(분당 최대 3번)과 슬라이드당 상한.
const DEFAULT_SCREEN_CHANGE_MIN_INTERVAL_MS = 20000;
const DEFAULT_SCREEN_CHANGE_PER_SLIDE_MAX = 2;
// 해설하는 사건 종류. visual(글자 없는 변화)은 오탐이 많아 기본으로 끈다.
const SCREEN_CHANGE_KIND_LIST = [SCREEN_CHANGE_KIND_MAP.newText, SCREEN_CHANGE_KIND_MAP.highlight, SCREEN_CHANGE_KIND_MAP.visual];
const DEFAULT_SCREEN_CHANGE_KIND_LIST = [SCREEN_CHANGE_KIND_MAP.newText, SCREEN_CHANGE_KIND_MAP.highlight];
// VLM 에 보내는 그림: outline 은 바뀐 곳에 테두리를 그린 전체 화면(라벨·축 이름을 지킨다), crop 은 바뀐 곳만, full 은 그대로.
const SCREEN_CHANGE_IMAGE_LIST = ['outline', 'crop', 'full'];
const DEFAULT_SCREEN_CHANGE_IMAGE = 'outline';

function readScreenChangeMode({ env }) {
  const mode = env.SEEON_SCREEN_CHANGE;
  if (mode === undefined || mode === '') return DEFAULT_SCREEN_CHANGE_MODE;
  if (SCREEN_CHANGE_MODE_LIST.includes(mode)) return mode;
  if (mode === SCREEN_CHANGE_MODE_ALL) {
    console.warn(`[pipeline] SEEON_SCREEN_CHANGE="all" — 새 슬라이드 값 한 줄은 아직 없어 ${SCREEN_CHANGE_MODE_MAP.sameSlide} 로 돕니다(같은 슬라이드 변화 해설·늦은 근거 재시도)`);
    return SCREEN_CHANGE_MODE_MAP.sameSlide;
  }
  console.warn(`[pipeline] SEEON_SCREEN_CHANGE="${mode}" 은 지원하지 않는 값입니다 — ${DEFAULT_SCREEN_CHANGE_MODE} 로 둡니다 (허용: ${SCREEN_CHANGE_MODE_LIST.join('·')})`);
  return DEFAULT_SCREEN_CHANGE_MODE;
}

function readPositiveInteger({ env, envName, fallback }) {
  const value = env[envName];
  if (value === undefined || value === '') return fallback;
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  console.warn(`[pipeline] ${envName}="${value}" 은 양의 정수가 아닙니다 — ${fallback} 로 둡니다`);
  return fallback;
}

function readScreenChangeKindList({ env }) {
  const value = env.SEEON_SCREEN_CHANGE_KINDS;
  if (value === undefined || value === '') return [...DEFAULT_SCREEN_CHANGE_KIND_LIST];
  const requestedList = value.split(',').map((kind) => kind.trim()).filter(Boolean);
  const kindList = SCREEN_CHANGE_KIND_LIST.filter((kind) => requestedList.includes(kind));
  const unknownList = requestedList.filter((kind) => !SCREEN_CHANGE_KIND_LIST.includes(kind));
  if (unknownList.length) {
    console.warn(`[pipeline] SEEON_SCREEN_CHANGE_KINDS 의 [${unknownList.join(', ')}] 는 모르는 종류라 뺍니다 (허용: ${SCREEN_CHANGE_KIND_LIST.join('·')})`);
  }
  return kindList.length ? kindList : [...DEFAULT_SCREEN_CHANGE_KIND_LIST];
}

function readScreenChangeImage({ env }) {
  const image = env.SEEON_SCREEN_CHANGE_IMAGE;
  if (image === undefined || image === '') return DEFAULT_SCREEN_CHANGE_IMAGE;
  if (SCREEN_CHANGE_IMAGE_LIST.includes(image)) return image;
  console.warn(`[pipeline] SEEON_SCREEN_CHANGE_IMAGE="${image}" 은 지원하지 않는 값입니다 — ${DEFAULT_SCREEN_CHANGE_IMAGE} 로 둡니다 (허용: ${SCREEN_CHANGE_IMAGE_LIST.join('·')})`);
  return DEFAULT_SCREEN_CHANGE_IMAGE;
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
    isFactCardEnabled: readFactCardSwitch({ env }) === 'on',
    factCardAgentList: readFactCardAgentList({ env }),
    factCardJsonMode: readFactCardJsonMode({ env }),
    chartEstimateMode: readChartEstimateMode({ env }),
    speechRoiMode: readOnOffSwitch({ env, envName: 'SEEON_SPEECH_ROI', defaultValue: DEFAULT_SPEECH_ROI_MODE }),
    speechRoiTypeList: readSpeechRoiTypeList({ env }),
    isSpeechRoiFrameOcrEnabled: readOnOffSwitch({ env, envName: 'SEEON_SPEECH_ROI_FRAME_OCR', defaultValue: DEFAULT_SPEECH_ROI_FRAME_OCR }) === 'on',
    isSpeechRoiPointingPairEnabled: readOnOffSwitch({ env, envName: 'SEEON_SPEECH_ROI_POINTING_PAIR', defaultValue: DEFAULT_SPEECH_ROI_POINTING_PAIR }) === 'on',
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
    isLiveSegmentSummaryEnabled: readOnOffSwitch({
      env, envName: 'SEEON_SUMMARY_LIVE_SEGMENTS', defaultValue: DEFAULT_SUMMARY_LIVE_SEGMENTS,
    }) === 'on',
    routerMode: env.SEEON_ROUTER_MODE || DEFAULT_ROUTER_MODE,
    // 추상적 척도 해설(화면에 보이는 대상의 정도)은 기본으로 켠다. 'false' 로 두면 척도 후보를 생성하지 않는다.
    isScaleEnabled: env.SEEON_ROUTER_SCALE_ENABLED !== 'false',
    // 지시·수치·척도 해설 내용 개선 항목별 스위치(기본 켜짐). 항목과 환경변수 이름은 content-switch.js.
    contentSwitch: readContentSwitch(env),
    screenChangeMode: readScreenChangeMode({ env }),
    screenChangeMinIntervalMs: readPositiveInteger({
      env, envName: 'SEEON_SCREEN_CHANGE_MIN_INTERVAL_MS', fallback: DEFAULT_SCREEN_CHANGE_MIN_INTERVAL_MS,
    }),
    screenChangePerSlideMax: readPositiveInteger({
      env, envName: 'SEEON_SCREEN_CHANGE_PER_SLIDE_MAX', fallback: DEFAULT_SCREEN_CHANGE_PER_SLIDE_MAX,
    }),
    screenChangeKindList: readScreenChangeKindList({ env }),
    screenChangeImage: readScreenChangeImage({ env }),
    hasBedrockCredentials:
      Boolean(env.AWS_BEARER_TOKEN_BEDROCK)
      || Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
      || Boolean(env.AWS_PROFILE),
  };
}

module.exports = {
  readPipelineConfig, DEFAULT_JUDGE_GPU_URL, DEFAULT_JUDGE_GPU_MODEL, ASR_LANGUAGE_LIST, DEFAULT_ASR_LANGUAGE, isAsrLanguage, JUDGE_BACKEND_LIST, DEFAULT_JUDGE_BACKEND,
  SLIDE_TEXT_BACKEND_LIST, DEFAULT_SLIDE_TEXT_BACKEND, resolveSlideTextBackend, GAP_SOURCE_LIST, DEFAULT_GAP_SOURCE,
  SCREEN_TEXT_GROUNDING_LIST, DEFAULT_SCREEN_TEXT_GROUNDING, FACT_CARD_AGENT_LIST, DEFAULT_FACT_CARD_AGENT_LIST,
  CHART_ESTIMATE_MODE_MAP, CHART_ESTIMATE_MODE_LIST, DEFAULT_CHART_ESTIMATE_MODE,
  SPEECH_ROI_MODE_LIST, DEFAULT_SPEECH_ROI_MODE, SPEECH_ROI_TYPE_LIST,
  SCREEN_CHANGE_MODE_MAP, SCREEN_CHANGE_MODE_LIST, SCREEN_CHANGE_IMAGE_LIST, DEFAULT_SCREEN_CHANGE_MIN_INTERVAL_MS,
};
