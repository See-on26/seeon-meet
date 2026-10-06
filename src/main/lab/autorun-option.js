const path = require('path');
const { readAsrLanguageOption } = require('./meeting-language-preset');

const ASR_LANGUAGE_ENV_NAME = 'SEEON_LAB_ASR_LANGUAGE';

// 확인 실행용: SEEON_LAB_AUTORUN=<영상> 이면 창이 뜬 뒤 바로 시작하고, 결과 폴더를 다 쓰면 앱을 끝낸다.
function readAutorunOption(env = process.env, { onWarn } = {}) {
  const videoPath = String(env.SEEON_LAB_AUTORUN || '').trim();
  if (!videoPath) return null;
  return {
    videoPath: path.resolve(videoPath),
    mode: env.SEEON_LAB_MODE || null,
    isEvalPreset: env.SEEON_LAB_EVAL_PRESET !== 'false',
    isExitOnDone: env.SEEON_LAB_EXIT_ON_DONE !== 'false',
    asrLanguage: readAsrLanguageOption({ value: env[ASR_LANGUAGE_ENV_NAME], envName: ASR_LANGUAGE_ENV_NAME, onWarn }),
  };
}

module.exports = { readAutorunOption };
