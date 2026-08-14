const { NARRATION_TYPE_MAP, SPEAKER_IDENTITY_KIND_MAP } = require('../contracts/narration-types');
const { assembleNarration } = require('./shared/narration-format');
const { GROUNDING_NONE_TOKEN } = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const {
  buildSpeakerIdentityPrompt, CONFIDENCE_MAP, DEFAULT_SPEAKER_MIN_WORD_COUNT, DEFAULT_SPEAKER_MAX_WORD_COUNT,
} = require('../prompts/speaker-identity');

const AGENT_LABEL = '발화자';
const SPEAKER_IDENTITY_MAX_TOKENS = 120;

const SPEAKER_IDENTITY_TEMPERATURE = 0.0;

function buildSpeakerKey({ speakerName, participantId = '', position }) {
  if (speakerName) return `name:${speakerName}`;
  if (participantId) return `participant:${participantId}`;
  if (position) return `position:${position}`;
  return '';
}

function parseSpeakerIdentityText(content) {
  const empty = {
    text: '', isGrounded: false, subKind: null, speakerName: '', position: '', speakerKey: '',
  };
  if (typeof content !== 'string') return empty;
  const cleaned = content.replace(/```(?:json)?/g, '').trim();
  const unquoted = cleaned.replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (!unquoted || new RegExp(`^${GROUNDING_NONE_TOKEN}\\b`, 'i').test(unquoted)) return empty;
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return empty;
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return empty;
  }

  if (parsed.confidence === CONFIDENCE_MAP.low) return empty;
  const speakerName = typeof parsed.speakerName === 'string' ? parsed.speakerName.trim() : '';
  const position = typeof parsed.position === 'string' ? parsed.position.trim() : '';
  const subKind = speakerName
    ? SPEAKER_IDENTITY_KIND_MAP.named : SPEAKER_IDENTITY_KIND_MAP.positional;
  const assembled = assembleNarration({
    narrationType: NARRATION_TYPE_MAP.speakerIdentity, subKind,
    rawSlotMap: { speakerName, position },
  });
  if (!assembled) return empty;
  return {
    text: assembled.text,
    isGrounded: true,
    subKind,
    speakerName: assembled.slotMap.speakerName || '',
    position: assembled.slotMap.position || '',
    speakerKey: buildSpeakerKey({
      speakerName: assembled.slotMap.speakerName || '',
      position: assembled.slotMap.position || '',
    }),
  };
}

function buildSpeakerIdentityFromDom({ speakerName = '', position = '', participantId = '' }) {
  const empty = {
    text: '', isGrounded: false, subKind: null, speakerName: '', position: '', speakerKey: '',
  };
  const subKind = speakerName
    ? SPEAKER_IDENTITY_KIND_MAP.named : SPEAKER_IDENTITY_KIND_MAP.positional;
  const assembled = assembleNarration({
    narrationType: NARRATION_TYPE_MAP.speakerIdentity, subKind,
    rawSlotMap: { speakerName, position },
  });
  if (!assembled) return empty;
  return {
    text: assembled.text,
    isGrounded: true,
    subKind,
    speakerName: assembled.slotMap.speakerName || '',
    position: assembled.slotMap.position || '',
    speakerKey: buildSpeakerKey({
      speakerName: assembled.slotMap.speakerName || '',
      participantId,
      position: assembled.slotMap.position || '',
    }),
  };
}

function createSpeakerIdentityAgent({ config }) {
  async function generate({ jpegBuffer, minWordCount, maxWordCount }) {
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL,
      maxTokens: SPEAKER_IDENTITY_MAX_TOKENS, temperature: SPEAKER_IDENTITY_TEMPERATURE,
      prompt: buildSpeakerIdentityPrompt({ minWordCount, maxWordCount }),
    });
    return parseSpeakerIdentityText(content);
  }

  return { generate };
}

module.exports = {
  createSpeakerIdentityAgent, buildSpeakerIdentityPrompt, parseSpeakerIdentityText,
  buildSpeakerIdentityFromDom, buildSpeakerKey, CONFIDENCE_MAP,
  DEFAULT_SPEAKER_MIN_WORD_COUNT, DEFAULT_SPEAKER_MAX_WORD_COUNT,
};
