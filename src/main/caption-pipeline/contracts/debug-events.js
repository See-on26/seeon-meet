const DEBUG_STAGE_MAP = {
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
  vlmFallback: 'vlm_fallback',
  context: 'context',
  question: 'question',
  silence: 'silence',
  queue: 'queue',
};

const DEBUG_VERDICT_MAP = { pass: 'pass', skip: 'skip', fail: 'fail', info: 'info' };

module.exports = { DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP };
