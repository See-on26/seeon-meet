export const ROI_TYPE_MAP = {
  screenShare: 'screen_share',
  speaker: 'speaker',
  audience: 'audience',
  camera: 'camera',
};

export const ROI_COLOR_MAP = {
  [ROI_TYPE_MAP.screenShare]: '#e04545',
  [ROI_TYPE_MAP.speaker]: '#3ecf6f',
  [ROI_TYPE_MAP.audience]: '#4a8de0',
  [ROI_TYPE_MAP.camera]: '#e0a815',
};

// 회의 코드(abc-defg-hij)가 도메인 바로 뒤나 meet/ 아래(meet/abc-defg-hij)에 붙은 Meet 주소.
// main meeting/meet-navigation.js 와 같은 규칙이다.
export const MEET_MEETING_URL_PATTERN = /^https:\/\/meet\.google\.com\/(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}/;

// Meet 새로고침이 회의를 다시 불렀는지, 회의 밖이라 첫 화면으로 돌아갔는지. main meeting/meet-reload.js 와 같은 값이다.
export const MEET_RELOAD_TARGET_MAP = { meeting: 'meeting', home: 'home' };

export const NARRATION_TYPE_MAP = {
  pageTransition: 'page_transition',
  deixis: 'deixis',
  interpretation: 'interpretation',
  visualDescription: 'visual_description',
  userCommand: 'user_command',
  speakerIdentity: 'speaker_identity',
  screenChange: 'screen_change',
};

export const NARRATION_CLASS_MAP = {
  userCommand: 'user_command',
  pageTransition: 'page_transition',
  deixis: 'deixis',
  speechBased: 'speech_based',
  silenceBased: 'silence_based',
  speakerIdentity: 'speaker_identity',
  screenChange: 'screen_change',
};

// AD 카드 코드. main contracts/narration-class.js 의 AD_CODE_BY_CLASS_MAP 과 같은 사본이다.
export const AD_CODE_BY_CLASS_MAP = {
  [NARRATION_CLASS_MAP.pageTransition]: 'A1',
  [NARRATION_CLASS_MAP.deixis]: 'A2',
  [NARRATION_CLASS_MAP.speechBased]: 'A3',
  [NARRATION_CLASS_MAP.silenceBased]: 'A4',
  [NARRATION_CLASS_MAP.speakerIdentity]: 'A5',
  [NARRATION_CLASS_MAP.screenChange]: 'A6',
  [NARRATION_CLASS_MAP.userCommand]: 'Q',
};

export const PAGE_TRANSITION_KIND_MAP = {
  slide: 'slide',
  document: 'document',
};

export const DEIXIS_FORM_MAP = {
  simple: 'simple',
  complete: 'complete',
};

export const DEIXIS_REFERENCE_MAP = {
  explicit: 'explicit',
  inclusive: 'inclusive',
};

export const INTERPRETATION_KIND_MAP = {
  valueToMeaning: 'value_to_meaning',
  claimToValue: 'claim_to_value',
};

export const VISUAL_DESCRIPTION_KIND_MAP = {
  reaction: 'reaction',
  scale: 'scale',
};

export const SPEAKER_IDENTITY_KIND_MAP = {
  named: 'named',
  positional: 'positional',
};

// 화면 변화 해설의 하위 종류. main contracts/narration-types.js 의 SCREEN_CHANGE_KIND_MAP 과 같은 사본이다.
export const SCREEN_CHANGE_KIND_MAP = {
  newText: 'new_text',
  highlight: 'highlight',
  visual: 'visual',
  newSlide: 'new_slide',
};

export const SPEAKER_SOURCE_MAP = {
  dom: 'dom',
  vlm: 'vlm',
};

export const USER_COMMAND_MAP = {
  screenMaterial: 'screen_material',
  pageSummary: 'page_summary',
  graphAxis: 'graph_axis',
};

export const SUMMARY_TOGGLE_KEY = '0';

// 회의 요약 진행 알림(summary-progress)의 단계. main summary/summary-generator.js 의 SUMMARY_STAGE_MAP 과 같은 사본이다.
export const SUMMARY_STAGE_MAP = {
  start: 'start',
  done: 'done',
  fail: 'fail',
  audioDone: 'audio-done',
};

export const SIC_WAVE_COLOR_MAP = {
  original: '#3ecf6f',
  caption: '#e04545',
  compressed: '#4a8de0',
};

export const ASR_SEGMENT_MS = 2500;

export const SIC_CATCHUP_MIN_RATE = 1.5;
export const SIC_CATCHUP_MAX_RATE = 1.8;
export const SIC_CATCHUP_RATE_PER_SEC = 0.1;

export const CROP_JPEG_QUALITY = 0.92;

export const DEBUG_STAGE_MAP = {
  session: 'session',
  slide: 'slide',
  screen: 'screen',
  speaker: 'speaker',
  screenDependency: 'screen_dependency',
  budget: 'budget',
  router: 'router',
  vlm: 'vlm',
  dedupe: 'dedupe',
  gap: 'gap',
  tts: 'tts',
  asr: 'asr',
  valueCheck: 'value_check',
  context: 'context',
  question: 'question',
  silence: 'silence',
  queue: 'queue',
  toggle: 'toggle',
  screenChange: 'screen_change',
};

export const DEBUG_VERDICT_MAP = { pass: 'pass', skip: 'skip', fail: 'fail', info: 'info' };
