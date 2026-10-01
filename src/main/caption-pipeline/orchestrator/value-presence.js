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

function normalizeForSearch(text) {
  return String(text || '').replace(/(\d),(\d)/g, '$1$2');
}

// 값 슬롯의 숫자가 화면 글자(값→의미는 발화도 포함)에 실제로 있는지 본다.
// 전사가 준비되지 않았거나 아라비아 숫자가 없으면 판단할 수 없으므로 막지 않는다.
function isValuePresent({ value, slideText = '', utterance = '', subKind, slideTextStatus }) {
  const coreList = extractNumberCoreList(value);
  if (!coreList.length) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: 'no-arabic-number' };
  }
  if (slideTextStatus !== SLIDE_TEXT_STATUS_MAP.ready) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: `slide-text-${slideTextStatus}` };
  }
  const sourceList = subKind === INTERPRETATION_KIND_MAP.claimToValue
    ? [slideText] : [slideText, utterance];
  const haystack = sourceList.map(normalizeForSearch).join('\n');
  const missingList = coreList.filter((core) => !containsNumberCore({ haystack, core }));
  if (missingList.length) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.absent, reason: `missing:${missingList.join(',')}` };
  }
  return { verdict: VALUE_PRESENCE_VERDICT_MAP.present, reason: '' };
}

module.exports = { isValuePresent, VALUE_PRESENCE_VERDICT_MAP };
