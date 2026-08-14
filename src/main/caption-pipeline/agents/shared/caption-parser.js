const { getSlotList, buildSlotInstruction, assembleNarration } = require('./narration-format');

const GROUNDING_NONE_TOKEN = 'NONE';

const DEFAULT_GROUNDING_MAX_CHARS = 30;

const CHARS_PER_WORD_ESTIMATE = 4.5;

const SLOT_PAIR_PATTERN = /"(\w+)"\s*:\s*"([^"]*)"/g;

function computeMaxChars({ maxWordCount }) {
  return Math.max(DEFAULT_GROUNDING_MAX_CHARS, Math.round(maxWordCount * CHARS_PER_WORD_ESTIMATE));
}

function buildSlotOutputInstruction({ narrationType, subKind, extraFieldList = [] }) {
  const slotList = getSlotList({ narrationType, subKind });
  if (!slotList) return '';
  return [
    '출력 형식 — JSON 한 줄만. 각 필드는 **그 어절 수를 지켜라**(고정 문구는 시스템이 붙이므로 넣지 마라).',
    '각 필드는 **소리 내어 읽었을 때 자연스러운, 명사로 끝나는 완결된 구**여야 한다.',
    '  끝내지 말 것: 조사(…이/가/을/를/은/는/와/과), 관형형(…하는/…되는/…나타내는), 관형사(두/세/여러/각/첫).',
    '  어절 수가 모자라면 대상을 줄이되 끝은 맺어라 — "팀 성과 공식과 두"(X) → "팀 성과 공식 두 가지"(O),'
      + ' "문제를 이기는"(X) → "문제 극복 방법"(O).',
    ...extraFieldList,
    buildSlotInstruction({ slotList }),
    `캡션을 낼 수 없으면 JSON 대신 정확히 "${GROUNDING_NONE_TOKEN}"만 출력한다.`,
    `**검토 과정을 글로 쓰지 마라. 첫 글자가 { 또는 ${GROUNDING_NONE_TOKEN[0]}이 아니면 실패다.**`,
  ].join('\n');
}

function truncateToWordCount({ text, maxWordCount }) {
  if (!Number.isFinite(maxWordCount) || maxWordCount <= 0) return text;
  const wordList = text.split(/\s+/).filter(Boolean);
  if (wordList.length <= maxWordCount) return text;
  return `${wordList.slice(0, maxWordCount).join(' ')}…`;
}

function salvageSlotMap({ text }) {
  const slotMap = {};
  for (const [, key, value] of text.matchAll(SLOT_PAIR_PATTERN)) {
    if (value.trim()) slotMap[key] = value.trim();
  }
  return Object.keys(slotMap).length ? slotMap : null;
}

function isSlotJsonAttempt({ text }) {
  return /"\w+"\s*:\s*"/.test(text);
}

function parseGroundingText(content, maxChars = DEFAULT_GROUNDING_MAX_CHARS, maxWordCount = null) {
  if (typeof content !== 'string') return { text: '', isGrounded: false };

  const cleaned = content
    .replace(/```/g, '')
    .replace(/\*+/g, '')
    .replace(/^\s*(?:[가-힣A-Za-z0-9 ·]{0,12}(?:형|캡션|내레이션|답변))\s*[:：]\s*/, '')
    .trim();
  if (!cleaned || new RegExp(`^${GROUNDING_NONE_TOKEN}\\b`, 'i').test(cleaned)) {
    return { text: '', isGrounded: false };
  }

  const wordTruncated = truncateToWordCount({ text: cleaned, maxWordCount });
  const text = wordTruncated.length > maxChars
    ? `${wordTruncated.slice(0, maxChars).trim()}…` : wordTruncated;
  return { text, isGrounded: true };
}

function parseSlotCaption({ content, narrationType, subKind, index = '', maxChars, maxWordCount }) {
  if (typeof content !== 'string') return { text: '', isGrounded: false, slotMap: null };
  const cleaned = content.replace(/```(?:json)?/g, '').trim();

  const unquoted = cleaned.replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (new RegExp(`^${GROUNDING_NONE_TOKEN}\\b`, 'i').test(unquoted)) {
    return { text: '', isGrounded: false, slotMap: null };
  }
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const assembled = assembleNarration({
        narrationType, subKind, rawSlotMap: JSON.parse(jsonMatch[0]), index,
      });
      if (assembled) return { ...assembled, isGrounded: true };

      return { text: '', isGrounded: false, slotMap: null };
    } catch {  }
  }
  if (isSlotJsonAttempt({ text: cleaned })) {
    const salvagedSlotMap = salvageSlotMap({ text: cleaned });
    const assembled = salvagedSlotMap
      && assembleNarration({ narrationType, subKind, rawSlotMap: salvagedSlotMap, index });
    if (assembled) return { ...assembled, isGrounded: true };
    return { text: '', isGrounded: false, slotMap: null };
  }
  return { ...parseGroundingText(cleaned, maxChars, maxWordCount), slotMap: null };
}

module.exports = {
  GROUNDING_NONE_TOKEN, DEFAULT_GROUNDING_MAX_CHARS, CHARS_PER_WORD_ESTIMATE,
  computeMaxChars, buildSlotOutputInstruction, truncateToWordCount,
  salvageSlotMap, isSlotJsonAttempt, parseGroundingText, parseSlotCaption,
};
