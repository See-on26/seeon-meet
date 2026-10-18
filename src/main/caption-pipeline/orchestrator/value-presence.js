const { INTERPRETATION_KIND_MAP } = require('../contracts/narration-types');
const { SLIDE_TEXT_STATUS_MAP } = require('./slide-text-store');

const VALUE_PRESENCE_VERDICT_MAP = {
  present: 'present',
  absent: 'absent',
  unchecked: 'unchecked',
};

// 값을 무엇과 대조했나. frame_ocr = 해설 요청과 같은 프레임의 OCR 글자, slide_text = 슬라이드 확정 때 저장한 전사.
const VALUE_CHECK_SOURCE_MAP = { frameOcr: 'frame_ocr', slideText: 'slide_text' };

const NUMBER_CORE_PATTERN = /\d+(?:[.,]\d+)*/g;

function extractNumberCoreList(text) {
  return (String(text || '').match(NUMBER_CORE_PATTERN) || []).map((core) => core.replace(/,/g, ''));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 앞뒤가 다른 숫자로 이어지면 같은 값이 아니다. 예: "73" 은 "73.5"·"173" 과 다르다.
function containsNumberCore({ haystack, core }) {
  const pattern = new RegExp(`(?<![\\d.])${escapeRegExp(core)}(?!\\d|\\.\\d)`);
  return pattern.test(haystack);
}

// ASR 이 수를 한글로 적으면("칠십삼 퍼센트", "두 배") 숫자로 정규화된 값과 글자로 대조할 수 없다.
const SINO_NUMERAL_PATTERN = /[일이삼사오육칠팔구십백천만억]+\s*(?:퍼센트|프로|배|명|건|개|원|위|년|세|단계|점|초|분|시간)/;
const NATIVE_NUMERAL_PATTERN = /(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|서른|마흔|쉰)\s*(?:배|명|건|개|가지|번|단계|곳|살)/;

function hasSpokenKoreanNumber(text) {
  return SINO_NUMERAL_PATTERN.test(text) || NATIVE_NUMERAL_PATTERN.test(text);
}

function normalizeForSearch(text) {
  return String(text || '').replace(/(\d),(\d)/g, '$1$2');
}

// 값 슬롯의 숫자가 화면 글자(값→의미는 트리거 발화와 앞뒤 발화도 포함)에 실제로 있는지 본다.
// 전사가 준비되지 않았거나 아라비아 숫자가 없으면 판단할 수 없으므로 막지 않는다.
function isValuePresent({ value, slideText = '', utterance = '', contextText = '', subKind,
  slideTextStatus }) {
  const coreList = extractNumberCoreList(value);
  if (!coreList.length) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: 'no-arabic-number' };
  }
  if (slideTextStatus !== SLIDE_TEXT_STATUS_MAP.ready) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: `slide-text-${slideTextStatus}` };
  }
  const isScreenOnly = subKind === INTERPRETATION_KIND_MAP.claimToValue;
  const sourceList = isScreenOnly ? [slideText] : [slideText, utterance, contextText];
  const haystack = sourceList.map(normalizeForSearch).join('\n');
  const missingList = coreList.filter((core) => !containsNumberCore({ haystack, core }));
  if (missingList.length && !isScreenOnly && hasSpokenKoreanNumber(`${utterance} ${contextText}`)) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: 'spoken-korean-numeral' };
  }
  if (missingList.length) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.absent, reason: `missing:${missingList.join(',')}` };
  }
  return { verdict: VALUE_PRESENCE_VERDICT_MAP.present, reason: '' };
}

async function confirmByRetranscription({ value, subKind, utterance, contextText, retranscribe }) {
  let fresh = null;
  try {
    fresh = await retranscribe();
  } catch (error) {
    return {
      verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: `retranscribe-failed:${error.message}`,
      isRetranscribed: true,
    };
  }
  if (!fresh?.hasText) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: 'retranscribe-empty', isRetranscribed: true };
  }
  const freshVerdict = isValuePresent({
    value, subKind, utterance, contextText, slideText: fresh.text,
    slideTextStatus: SLIDE_TEXT_STATUS_MAP.ready,
  });
  return {
    ...freshVerdict, reason: `retranscribed${freshVerdict.reason ? `:${freshVerdict.reason}` : ''}`,
    isRetranscribed: true,
  };
}

// frameText: 해설이 본 것과 같은 프레임의 OCR 글자(믿을 줄만). 있으면 그것으로 먼저 보고, 값이 없으면 저장 전사를 거치지 않고
// 지금 화면을 VLM 으로 다시 전사해 확인한다(OCR 오독을 다른 엔진으로 거른다). null 이면 지금처럼 저장 전사로 본다.
// 저장된 전사는 슬라이드 확정 순간의 화면이라, 클릭마다 항목이 나타나는 슬라이드나
// 출력 상한에 잘린 긴 표에서는 실제로 화면에 있는 값도 없다고 나온다.
// 없다고 나올 때만 지금 요청에 쓰인 화면을 다시 전사해 한 번 더 확인한다.
async function verifyValuePresence({ value, subKind, utterance = '', contextText = '', slideText = '',
  slideTextStatus, frameText = null, retranscribe }) {
  const isFrameChecked = typeof frameText === 'string';
  const checkedSource = isFrameChecked ? VALUE_CHECK_SOURCE_MAP.frameOcr : VALUE_CHECK_SOURCE_MAP.slideText;
  const firstVerdict = isValuePresent({
    value, subKind, utterance, contextText,
    slideText: isFrameChecked ? frameText : slideText,
    slideTextStatus: isFrameChecked ? SLIDE_TEXT_STATUS_MAP.ready : slideTextStatus,
  });
  if (firstVerdict.verdict !== VALUE_PRESENCE_VERDICT_MAP.absent) {
    return { ...firstVerdict, isRetranscribed: false, checkedSource };
  }
  return {
    ...await confirmByRetranscription({ value, subKind, utterance, contextText, retranscribe }),
    checkedSource,
  };
}

module.exports = { isValuePresent, verifyValuePresence, VALUE_PRESENCE_VERDICT_MAP, VALUE_CHECK_SOURCE_MAP };
