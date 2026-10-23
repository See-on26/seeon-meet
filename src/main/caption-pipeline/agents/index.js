const { NARRATION_TYPE_MAP } = require('../contracts/narration-types');
const { createPageTransitionAgent } = require('./page-transition-agent');
const { createDeixisResolutionAgent } = require('./deixis-resolution-agent');
const { createInterpretiveBridgeAgent } = require('./interpretive-bridge-agent');
const { createVisualDescriptionAgent } = require('./visual-description-agent');
const { createCommandProcessingAgent } = require('./command-processing-agent');
const { createSpeakerIdentityAgent } = require('./speaker-identity-agent');
const { createScreenChangeAgent } = require('./screen-change-agent');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');

// getCaptionLanguage 는 이번 세션의 캡션 언어를 돌려준다. 에이전트는 부를 때마다 읽어 그 언어로 해설을 만든다.
function createAgentFieldMap({ config, getCaptionLanguage = () => DEFAULT_CAPTION_LANGUAGE }) {
  const option = { config, getCaptionLanguage };
  return {
    [NARRATION_TYPE_MAP.pageTransition]: createPageTransitionAgent(option),
    [NARRATION_TYPE_MAP.deixis]: createDeixisResolutionAgent(option),
    [NARRATION_TYPE_MAP.interpretation]: createInterpretiveBridgeAgent(option),
    [NARRATION_TYPE_MAP.visualDescription]: createVisualDescriptionAgent(option),
    [NARRATION_TYPE_MAP.userCommand]: createCommandProcessingAgent(option),
    [NARRATION_TYPE_MAP.speakerIdentity]: createSpeakerIdentityAgent(option),
    [NARRATION_TYPE_MAP.screenChange]: createScreenChangeAgent(option),
  };
}

module.exports = { createAgentFieldMap };
