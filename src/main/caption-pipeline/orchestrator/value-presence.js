const { INTERPRETATION_KIND_MAP } = require('../contracts/narration-types');
const { SLIDE_TEXT_STATUS_MAP } = require('./slide-text-store');

const VALUE_PRESENCE_VERDICT_MAP = {
  present: 'present',
  absent: 'absent',
  unchecked: 'unchecked',
};

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

// 저장된 전사는 슬라이드 확정 순간의 화면이라, 클릭마다 항목이 나타나는 슬라이드나
// 출력 상한에 잘린 긴 표에서는 실제로 화면에 있는 값도 없다고 나온다.
// 없다고 나올 때만 지금 요청에 쓰인 화면을 다시 전사해 한 번 더 확인한다.
async function verifyValuePresence({ value, subKind, utterance = '', contextText = '', slideText = '',
  slideTextStatus, retranscribe }) {
  const storedVerdict = isValuePresent({
    value, subKind, utterance, contextText, slideText, slideTextStatus,
  });
  if (storedVerdict.verdict !== VALUE_PRESENCE_VERDICT_MAP.absent) {
    return { ...storedVerdict, isRetranscribed: false };
  }
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

module.exports = { isValuePresent, verifyValuePresence, VALUE_PRESENCE_VERDICT_MAP };
