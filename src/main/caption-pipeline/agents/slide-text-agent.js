const { requestVlmContent } = require('./shared/vlm-gateway');
const { GROUNDING_NONE_TOKEN } = require('./shared/caption-parser');
const { buildSlideTextPrompt } = require('../prompts/slide-text');

const AGENT_LABEL = '슬라이드전사';
const SLIDE_TEXT_MAX_TOKENS = 600;
const CODE_FENCE_PATTERN = /```[a-zA-Z]*\n?|```/g;

function createSlideTextAgent({ config }) {
  async function transcribe({ jpegBuffer }) {
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, prompt: buildSlideTextPrompt(),
      temperature: 0, maxTokens: SLIDE_TEXT_MAX_TOKENS,
    });
    const text = String(content || '').replace(CODE_FENCE_PATTERN, '').trim();
    if (!text || text.toUpperCase() === GROUNDING_NONE_TOKEN) return { text: '', hasText: false };
    return { text, hasText: true };
  }

  return { transcribe };
}

module.exports = { createSlideTextAgent };
