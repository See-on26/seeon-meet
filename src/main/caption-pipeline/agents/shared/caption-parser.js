const { getSlotList, buildSlotInstruction, assembleNarration } = require('./narration-format');

const GROUNDING_NONE_TOKEN = 'NONE';

const DEFAULT_GROUNDING_MAX_CHARS = 30;

const CHARS_PER_WORD_ESTIMATE = 4.5;

const SLOT_PAIR_PATTERN = /"(\w+)"\s*:\s*"([^"]*)"/g;

// Qwen 계열 VLM 이 화면의 한글 낱말을 중국어로 바꿔 쓰는 일이 있다(예: "중식" → "中式").
// 한국어 TTS 가 읽지 못하고 자막에도 그대로 보이므로, 해설에 한자가 섞이면 내보내지 않는다.
// 참가자 이름을 말하는 화자 해설은 여기를 거치지 않으므로 한자 이름은 막히지 않는다.
const HAN_CHARACTER_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const NO_HAN_RULE = '각 필드에 한자·중국어 글자를 섞지 마라. 화면 글자가 한글이면 한글 그대로 쓴다.';

// 해설을 내지 못한 까닭. 모델이 스스로 거절했는지(none), 답이 칸을 채우지 못했는지(format), 한자가 섞였는지(han)를 나눠야
// "판단은 통과했는데 왜 버려졌나"를 기록만 보고 알 수 있다.
const REJECT_KIND_MAP = { none: 'none', format: 'format', han: 'han' };
const REJECT_REASON_MAX_CHARS = 200;
const RAW_CONTENT_MAX_CHARS = 400;
const RAW_CONTENT_DISPLAY_MAX_CHARS = 300;
const NONE_REASON_PATTERN = new RegExp(`^${GROUNDING_NONE_TOKEN}\\b\\s*[:：\\-—]?\\s*([\\s\\S]*)$`, 'i');
// 거절 이유 한 문장까지 쓰게 기본 상한(200)보다 넉넉히 둔다. 칸이 많은 형식(지시 complete)이 잘리는 것도 막는다.
const SLOT_AGENT_MAX_TOKENS = 400;

function buildRejection({ rejectKind, rejectReason = '', content = '' }) {
  return {
    text: '', isGrounded: false, slotMap: null, rejectKind,
    rejectReason, rawContent: String(content || '').slice(0, RAW_CONTENT_MAX_CHARS),
  };
}

function readNoneReason(text) {
  const match = NONE_REASON_PATTERN.exec(text);
  return (match?.[1] || '').replace(/\s+/g, ' ').replace(/^["'“‘]+|["'”’]+$/g, '').trim().slice(0, REJECT_REASON_MAX_CHARS);
}

// 기록·흐름 창의 사유 문구. 모델이 거절했으면 그 이유를, 형식 오류·한자면 원문을 함께 보인다.
function describeAgentRejection({ rejectKind = null, rejectReason = '', rawContent = '' } = {}) {
  const rawText = String(rawContent || '').replace(/\s+/g, ' ').trim();
  const shownRaw = rawText.length > RAW_CONTENT_DISPLAY_MAX_CHARS ? `${rawText.slice(0, RAW_CONTENT_DISPLAY_MAX_CHARS)}…` : rawText;
  if (rejectKind === REJECT_KIND_MAP.han) return { reason: '한자 섞임 — 내보내지 않음', detailPrefix: `원문="${shownRaw}" · ` };
  if (rejectKind === REJECT_KIND_MAP.format) {
    return { reason: '형식 오류 — 칸을 채우지 못함(잘림·빈 칸·끝맺음)', detailPrefix: `원문="${shownRaw}" · ` };
  }
  return { reason: `NONE — ${rejectReason || '이유를 적지 않음'}`, detailPrefix: '' };
}

function containsHanCharacter(text) {
  return HAN_CHARACTER_PATTERN.test(String(text || ''));
}

function computeMaxChars({ maxWordCount }) {
  return Math.max(DEFAULT_GROUNDING_MAX_CHARS, Math.round(maxWordCount * CHARS_PER_WORD_ESTIMATE));
}

function buildSlotOutputInstruction({ narrationType, subKind, origin = null, extraFieldList = [] }) {
  const slotList = getSlotList({ narrationType, subKind, origin });
  if (!slotList) return '';
  return [
    '출력 형식 — JSON 한 줄만. 각 필드는 **그 어절 수를 지켜라**(고정 문구는 시스템이 붙이므로 넣지 마라).',
    '각 필드는 **소리 내어 읽었을 때 자연스러운, 명사로 끝나는 완결된 구**여야 한다.',
    '  끝내지 말 것: 조사(…이/가/을/를/은/는/와/과), 관형형(…하는/…되는/…나타내는), 관형사(두/세/여러/각/첫).',
    '  어절 수가 모자라면 대상을 줄이되 끝은 맺어라 — "팀 성과 공식과 두"(X) → "팀 성과 공식 두 가지"(O),'
      + ' "문제를 이기는"(X) → "문제 극복 방법"(O).',
    NO_HAN_RULE,
    ...extraFieldList,
    buildSlotInstruction({ slotList }),
    `캡션을 낼 수 없으면 JSON 대신 "${GROUNDING_NONE_TOKEN}: (거절 이유)" 한 줄을 출력한다.`
      + ' 거절 이유에는 해당한 조건과 그렇게 본 근거(화면에서 본 것·발화에서 판단한 것)를 한 문장으로 쓴다.'
      + ` 다른 규칙의 "${GROUNDING_NONE_TOKEN}만 출력한다"도 이 꼴이다.`,
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

function parseSlotCaption(option) {
  const result = parseSlotCaptionContent(option);
  return result.isGrounded && containsHanCharacter(result.text)
    ? buildRejection({ rejectKind: REJECT_KIND_MAP.han, content: option.content }) : result;
}

function parseSlotCaptionContent({ content, narrationType, subKind, origin = null, index = '', maxChars, maxWordCount }) {
  if (typeof content !== 'string') return buildRejection({ rejectKind: REJECT_KIND_MAP.format });
  const cleaned = content.replace(/```(?:json)?/g, '').trim();

  const unquoted = cleaned.replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (new RegExp(`^${GROUNDING_NONE_TOKEN}\\b`, 'i').test(unquoted)) {
    return buildRejection({ rejectKind: REJECT_KIND_MAP.none, rejectReason: readNoneReason(unquoted), content });
  }
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const assembled = assembleNarration({
        narrationType, subKind, rawSlotMap: JSON.parse(jsonMatch[0]), index, origin,
      });
      if (assembled) return { ...assembled, isGrounded: true };

      return buildRejection({ rejectKind: REJECT_KIND_MAP.format, content });
    } catch {  }
  }
  if (isSlotJsonAttempt({ text: cleaned })) {
    const salvagedSlotMap = salvageSlotMap({ text: cleaned });
    const assembled = salvagedSlotMap
      && assembleNarration({ narrationType, subKind, rawSlotMap: salvagedSlotMap, index, origin });
    if (assembled) return { ...assembled, isGrounded: true };
    return buildRejection({ rejectKind: REJECT_KIND_MAP.format, content });
  }
  return { ...parseGroundingText(cleaned, maxChars, maxWordCount), slotMap: null };
}

module.exports = {
  GROUNDING_NONE_TOKEN, DEFAULT_GROUNDING_MAX_CHARS, CHARS_PER_WORD_ESTIMATE,
  computeMaxChars, buildSlotOutputInstruction, truncateToWordCount, containsHanCharacter,
  REJECT_KIND_MAP, SLOT_AGENT_MAX_TOKENS, describeAgentRejection,
  salvageSlotMap, isSlotJsonAttempt, parseGroundingText, parseSlotCaption,
};
