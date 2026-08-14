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
};

const DEBUG_VERDICT_MAP = { pass: 'pass', skip: 'skip', fail: 'fail', info: 'info' };

module.exports = { DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP };
