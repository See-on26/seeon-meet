const { NARRATION_TYPE_MAP, SPEAKER_IDENTITY_KIND_MAP } = require('../contracts/narration-types');
const { assembleNarration } = require('./shared/narration-format');
const { GROUNDING_NONE_TOKEN } = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const {
  buildSpeakerIdentityPrompt, CONFIDENCE_MAP, DEFAULT_SPEAKER_MIN_WORD_COUNT, DEFAULT_SPEAKER_MAX_WORD_COUNT,
} = require('../prompts/speaker-identity');
const { CAPTION_LANGUAGE_MAP, DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');

const AGENT_LABEL = '발화자';
const SPEAKER_IDENTITY_MAX_TOKENS = 120;

const SPEAKER_IDENTITY_TEMPERATURE = 0.0;

// 회의앱 DOM 경로의 타일 위치는 렌더러가 한국어 고정 낱말(왼쪽·가운데·오른쪽 × 위·중간·아래)로 보낸다.
// 영어 캡션이면 들려주기 전에 영어 위치로 바꾼다. VLM 이 한국어 위치를 낸 경우도 같은 표로 바꾼다.
const ENGLISH_POSITION_MAP = {
  '왼쪽 위': 'top left', '오른쪽 위': 'top right', '왼쪽 아래': 'bottom left', '오른쪽 아래': 'bottom right',
  '왼쪽': 'left', '오른쪽': 'right', '위': 'top', '아래': 'bottom', '가운데': 'center', '중간': 'center',
};

function toSpokenPosition({ position, language }) {
  if (language !== CAPTION_LANGUAGE_MAP.en) return position;
  return ENGLISH_POSITION_MAP[position] || position;
}

function buildSpeakerKey({ speakerName, participantId = '', position }) {
  if (speakerName) return `name:${speakerName}`;
  if (participantId) return `participant:${participantId}`;
  if (position) return `position:${position}`;
  return '';
}

function parseSpeakerIdentityText(content, { language = DEFAULT_CAPTION_LANGUAGE } = {}) {
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
  const position = toSpokenPosition({
    position: typeof parsed.position === 'string' ? parsed.position.trim() : '', language,
  });
  const subKind = speakerName
    ? SPEAKER_IDENTITY_KIND_MAP.named : SPEAKER_IDENTITY_KIND_MAP.positional;
  const assembled = assembleNarration({
    narrationType: NARRATION_TYPE_MAP.speakerIdentity, subKind,
    rawSlotMap: { speakerName, position }, language,
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

function buildSpeakerIdentityFromDom({ speakerName = '', position = '', participantId = '',
  language = DEFAULT_CAPTION_LANGUAGE }) {
  const empty = {
    text: '', isGrounded: false, subKind: null, speakerName: '', position: '', speakerKey: '',
  };
  const subKind = speakerName
    ? SPEAKER_IDENTITY_KIND_MAP.named : SPEAKER_IDENTITY_KIND_MAP.positional;
  const assembled = assembleNarration({
    narrationType: NARRATION_TYPE_MAP.speakerIdentity, subKind,
    rawSlotMap: { speakerName, position: toSpokenPosition({ position, language }) }, language,
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

function createSpeakerIdentityAgent({ config, getCaptionLanguage = () => DEFAULT_CAPTION_LANGUAGE }) {
  async function generate({ jpegBuffer, minWordCount, maxWordCount, language = getCaptionLanguage() }) {
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL,
      maxTokens: SPEAKER_IDENTITY_MAX_TOKENS, temperature: SPEAKER_IDENTITY_TEMPERATURE,
      prompt: buildSpeakerIdentityPrompt({ minWordCount, maxWordCount, language }),
    });
    return parseSpeakerIdentityText(content, { language });
  }

  return { generate };
}

module.exports = {
  createSpeakerIdentityAgent, buildSpeakerIdentityPrompt, parseSpeakerIdentityText,
  buildSpeakerIdentityFromDom, buildSpeakerKey, CONFIDENCE_MAP,
  DEFAULT_SPEAKER_MIN_WORD_COUNT, DEFAULT_SPEAKER_MAX_WORD_COUNT,
};
