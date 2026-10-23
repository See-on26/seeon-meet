// 해설 글의 아라비아 숫자를 화면·발화 글자와 견주는 공통 함수. 값 검사(value-presence)와 해설 조립(narration-format)이
// 함께 쓴다. 두 모듈이 서로를 불러오지 않게 아무것도 불러오지 않는 이 파일에 둔다.
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

// value 의 숫자 가운데 haystack 글자에 없는 것. 천 단위 쉼표는 양쪽 모두 떼고 견준다.
function findMissingNumberCoreList({ value, haystack }) {
  const normalized = normalizeForSearch(haystack);
  return extractNumberCoreList(value).filter((core) => !containsNumberCore({ haystack: normalized, core }));
}

module.exports = {
  NUMBER_CORE_PATTERN, extractNumberCoreList, containsNumberCore, normalizeForSearch, findMissingNumberCoreList,
};
