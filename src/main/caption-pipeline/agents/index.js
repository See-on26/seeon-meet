const { NARRATION_TYPE_MAP } = require('../contracts/narration-types');
const { createPageTransitionAgent } = require('./page-transition-agent');
const { createDeixisResolutionAgent } = require('./deixis-resolution-agent');
const { createInterpretiveBridgeAgent } = require('./interpretive-bridge-agent');
const { createVisualDescriptionAgent } = require('./visual-description-agent');
const { createCommandProcessingAgent } = require('./command-processing-agent');
const { createSpeakerIdentityAgent } = require('./speaker-identity-agent');

function createAgentFieldMap({ config }) {
  return {
    [NARRATION_TYPE_MAP.pageTransition]: createPageTransitionAgent({ config }),
    [NARRATION_TYPE_MAP.deixis]: createDeixisResolutionAgent({ config }),
    [NARRATION_TYPE_MAP.interpretation]: createInterpretiveBridgeAgent({ config }),
    [NARRATION_TYPE_MAP.visualDescription]: createVisualDescriptionAgent({ config }),
    [NARRATION_TYPE_MAP.userCommand]: createCommandProcessingAgent({ config }),
    [NARRATION_TYPE_MAP.speakerIdentity]: createSpeakerIdentityAgent({ config }),
  };
}

module.exports = { createAgentFieldMap };
