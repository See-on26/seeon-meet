const NARRATION_TYPE_MAP = {
  pageTransition: 'page_transition',
  deixis: 'deixis',
  interpretation: 'interpretation',
  visualDescription: 'visual_description',
  userCommand: 'user_command',
  speakerIdentity: 'speaker_identity',
};

const PAGE_TRANSITION_KIND_MAP = {
  slide: 'slide',
  document: 'document',
};

const DEIXIS_FORM_MAP = {
  simple: 'simple',
  complete: 'complete',
};

const DEIXIS_REFERENCE_MAP = {
  explicit: 'explicit',
  inclusive: 'inclusive',
};

const INTERPRETATION_KIND_MAP = {
  valueToMeaning: 'value_to_meaning',
  claimToValue: 'claim_to_value',
};

const VISUAL_DESCRIPTION_KIND_MAP = {
  reaction: 'reaction',
  scale: 'scale',
};

const SPEAKER_IDENTITY_KIND_MAP = {
  named: 'named',
  positional: 'positional',
};

const SPEAKER_SOURCE_MAP = {
  dom: 'dom',
  vlm: 'vlm',
};

const USER_COMMAND_MAP = {
  screenMaterial: 'screen_material',
  pageSummary: 'page_summary',
  graphAxis: 'graph_axis',
};

// 재생 우선순위·기능 토글·즉답 분기가 함께 쓰는 재생 분류. main 이 정하고 렌더러는 읽기만 한다.
const NARRATION_CLASS_MAP = {
  userCommand: 'user_command',
  pageTransition: 'page_transition',
  deixis: 'deixis',
  speechBased: 'speech_based',
  silenceBased: 'silence_based',
  speakerIdentity: 'speaker_identity',
};

module.exports = {
  NARRATION_TYPE_MAP, PAGE_TRANSITION_KIND_MAP, DEIXIS_FORM_MAP,
  DEIXIS_REFERENCE_MAP, INTERPRETATION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP,
  SPEAKER_IDENTITY_KIND_MAP, SPEAKER_SOURCE_MAP, USER_COMMAND_MAP, NARRATION_CLASS_MAP,
};
