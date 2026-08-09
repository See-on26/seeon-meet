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

export const MEET_MEETING_URL_PATTERN = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/;

export const NARRATION_TYPE_MAP = {
  pageTransition: 'page_transition',
  deixis: 'deixis',
  interpretation: 'interpretation',
  visualDescription: 'visual_description',
  userCommand: 'user_command',
  speakerIdentity: 'speaker_identity',
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

export const SPEAKER_SOURCE_MAP = {
  dom: 'dom',
  vlm: 'vlm',
};

export const USER_COMMAND_MAP = {
  screenMaterial: 'screen_material',
  pageSummary: 'page_summary',
  graphAxis: 'graph_axis',
};

export const USER_COMMAND_KEY_MAP = {
  5: USER_COMMAND_MAP.screenMaterial,
  6: USER_COMMAND_MAP.pageSummary,
  7: USER_COMMAND_MAP.graphAxis,
};

export const SUMMARY_TOGGLE_KEY = '0';

export const SCU_WAVE_COLOR_MAP = {
  original: '#3ecf6f',
  caption: '#e04545',
  compressed: '#4a8de0',
};

export const ASR_SEGMENT_MS = 2500;

export const SCU_CATCHUP_MIN_RATE = 1.5;
export const SCU_CATCHUP_MAX_RATE = 1.8;
export const SCU_CATCHUP_RATE_PER_SEC = 0.1;

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
};

export const DEBUG_VERDICT_MAP = { pass: 'pass', skip: 'skip', fail: 'fail', info: 'info' };
