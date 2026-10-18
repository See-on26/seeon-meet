const { getSlotList, buildSlotInstruction, assembleNarration } = require('./narration-format');
const { CAPTION_LANGUAGE_MAP } = require('../../contracts/caption-language');

const GROUNDING_NONE_TOKEN = 'NONE';

const DEFAULT_GROUNDING_MAX_CHARS = 30;

const CHARS_PER_WORD_ESTIMATE = 4.5;
// 영어 단어는 한국어 어절보다 길다(공백 포함 평균 약 6~7자). 한국어 추정치로 자르면 영어 답이 일찍 잘린다.
const ENGLISH_CHARS_PER_WORD_ESTIMATE = 7;

const SLOT_PAIR_PATTERN = /"(\w+)"\s*:\s*"([^"]*)"/g;

// Qwen 계열 VLM 이 화면의 한글 낱말을 중국어로 바꿔 쓰는 일이 있다(예: "중식" → "中式").
// 한국어 TTS 가 읽지 못하고 자막에도 그대로 보이므로, 해설에 한자가 섞이면 내보내지 않는다.
// 참가자 이름을 말하는 화자 해설은 여기를 거치지 않으므로 한자 이름은 막히지 않는다.
const HAN_CHARACTER_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const NO_HAN_RULE = '각 필드에 한자·중국어 글자를 섞지 마라. 화면 글자가 한글이면 한글 그대로 쓴다.';
const ENGLISH_NO_HAN_RULE = 'Do not mix Chinese characters (Hanja/Hanzi) or Korean letters into any field.';
// 발화에 정보 공백이 있는지는 라우터(판단 LLM)가 정한다. 에이전트가 같은 발화를 다시 판단하면 두 기준이 어긋날 때마다
// 해설이 버려지므로, 생성 에이전트는 화면 근거로만 거절한다.
const SPEECH_GAP_DECIDED_RULE = '발화에 정보 공백이 있다는 판단은 이미 끝났다.'
  + ' 발화가 무엇을 말했는지 다시 따지지 말고, 캡션을 낼지는 화면만 보고 정한다.';

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

function computeMaxChars({ maxWordCount, language = CAPTION_LANGUAGE_MAP.ko }) {
  const charsPerWord = language === CAPTION_LANGUAGE_MAP.en ? ENGLISH_CHARS_PER_WORD_ESTIMATE : CHARS_PER_WORD_ESTIMATE;
  return Math.max(DEFAULT_GROUNDING_MAX_CHARS, Math.round(maxWordCount * charsPerWord));
}

// 영어 캡션의 출력 형식. 한국어 끝맺음(조사·관형형) 규칙 대신 영어 구가 끊기지 않게 하는 규칙을 둔다.
function buildEnglishSlotOutputInstruction({ slotList, extraFieldList }) {
  return [
    'Output format — a single line of JSON only. Keep **each field within its word count**'
      + ' (the system adds the fixed phrases, so do not include them).',
    'Each field must be a **complete, natural English phrase** that sounds natural when read aloud.',
    '  Do not end a field with a dangling article or conjunction (a/an/the/and/or), and do not cut a phrase off mid-way.'
      + ' If words run short, drop the less important detail but finish the phrase.',
    ENGLISH_NO_HAN_RULE,
    ...extraFieldList,
    buildSlotInstruction({ slotList, language: CAPTION_LANGUAGE_MAP.en }),
    `If you cannot produce a caption, output a single line "${GROUNDING_NONE_TOKEN}: (reason)" instead of JSON.`
      + ' In the reason, state in one sentence which condition applied and what you saw on screen that made you think so.'
      + ` Wherever another rule says "output only ${GROUNDING_NONE_TOKEN}", use this same form.`,
    `**Do not write out your review process. If the first character is not { or ${GROUNDING_NONE_TOKEN[0]}, it fails.**`,
  ].join('\n');
}

function buildSlotOutputInstruction({ narrationType, subKind, origin = null, extraFieldList = [], hasSecondClaim = false,
  language = CAPTION_LANGUAGE_MAP.ko }) {
  const slotList = getSlotList({ narrationType, subKind, origin, hasSecondClaim, language });
  if (!slotList) return '';
  if (language === CAPTION_LANGUAGE_MAP.en) return buildEnglishSlotOutputInstruction({ slotList, extraFieldList });
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
      + ' 거절 이유에는 해당한 조건과 그렇게 본 근거(화면에서 본 것)를 한 문장으로 쓴다.'
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

// 모델이 "…정보가 없습니다. NONE" 처럼 설명 뒤에 토큰을 붙이는 경우. 토큰이 사용자에게 읽히지 않게 답 없음으로 본다.
// 대문자 토큰이 끝에 홀로 있을 때만 본다(문장 가운데 NONE·영어 소문자 none 은 답으로 둔다).
const TRAILING_NONE_PATTERN = new RegExp(`(?:^|[\\s.,!?。])["'“”‘’]?${GROUNDING_NONE_TOKEN}["'“”‘’]?[.。!]?\\s*$`);

function parseGroundingText(content, maxChars = DEFAULT_GROUNDING_MAX_CHARS, maxWordCount = null) {
  if (typeof content !== 'string') return { text: '', isGrounded: false };

  const cleaned = content
    .replace(/```/g, '')
    .replace(/\*+/g, '')
    .replace(/^\s*(?:[가-힣A-Za-z0-9 ·]{0,12}(?:형|캡션|내레이션|답변))\s*[:：]\s*/, '')
    .trim();
  if (!cleaned || new RegExp(`^${GROUNDING_NONE_TOKEN}\\b`, 'i').test(cleaned) || TRAILING_NONE_PATTERN.test(cleaned)) {
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

function parseSlotCaptionContent({ content, narrationType, subKind, origin = null, index = '', maxChars, maxWordCount,
  hasSecondClaim = false, language = CAPTION_LANGUAGE_MAP.ko }) {
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
        narrationType, subKind, rawSlotMap: JSON.parse(jsonMatch[0]), index, origin, hasSecondClaim, maxWordCount, language,
      });
      if (assembled) return { ...assembled, isGrounded: true };

      return buildRejection({ rejectKind: REJECT_KIND_MAP.format, content });
    } catch {  }
  }
  if (isSlotJsonAttempt({ text: cleaned })) {
    const salvagedSlotMap = salvageSlotMap({ text: cleaned });
    const assembled = salvagedSlotMap
      && assembleNarration({
        narrationType, subKind, rawSlotMap: salvagedSlotMap, index, origin, hasSecondClaim, maxWordCount, language,
      });
    if (assembled) return { ...assembled, isGrounded: true };
    return buildRejection({ rejectKind: REJECT_KIND_MAP.format, content });
  }
  return { ...parseGroundingText(cleaned, maxChars, maxWordCount), slotMap: null };
}

module.exports = {
  GROUNDING_NONE_TOKEN, DEFAULT_GROUNDING_MAX_CHARS, CHARS_PER_WORD_ESTIMATE, ENGLISH_CHARS_PER_WORD_ESTIMATE,
  computeMaxChars, buildSlotOutputInstruction, truncateToWordCount, containsHanCharacter,
  REJECT_KIND_MAP, SLOT_AGENT_MAX_TOKENS, describeAgentRejection, SPEECH_GAP_DECIDED_RULE,
  salvageSlotMap, isSlotJsonAttempt, parseGroundingText, parseSlotCaption,
};
