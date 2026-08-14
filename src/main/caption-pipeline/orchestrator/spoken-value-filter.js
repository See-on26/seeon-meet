// 화면에 새로 뜬 줄 중 발표자가 이미 말했거나 이미 해설한 것을 뺀다. 남은 줄이 없으면 화면 변화 해설 VLM 을 부르지 않는다.
// 숫자가 있는 줄은 그 줄의 숫자가 모두 대조 글에 있으면 뺀다. 숫자가 없는 줄은 줄의 글자 쌍(바이그램)이 대조 글에
// 이 비율 이상 들어 있으면 뺀다(받아쓰기는 그 줄보다 길어 서로 견준 유사도로는 같은 문장도 낮게 나온다).
// 한글 수사("사십이 퍼센트")는 숫자와 맞추지 않는다.
const { normalizeNarration } = require('./narration-history');

const SPOKEN_FILTER_REASON_MAP = { spoken: 'spoken', alreadyNarrated: 'already_narrated' };
const TEXT_CONTAINMENT_THRESHOLD = 0.7;
const NUMBER_CORE_PATTERN = /\d+(?:[.,]\d+)*/g;
const DIGIT_PATTERN = /\d/;

function normalizeNumberGrouping(text) {
  return String(text || '').replace(/(\d)[,，](?=\d)/g, '$1');
}

function extractNumberCoreList(text) {
  return normalizeNumberGrouping(text).match(NUMBER_CORE_PATTERN) || [];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 앞뒤가 다른 숫자로 이어지면 같은 수가 아니다("42" 는 "142"·"42.5" 와 다르다).
function containsNumberCore({ haystack, core }) {
  return new RegExp(`(?<![\\d.])${escapeRegExp(core)}(?!\\d|\\.\\d)`).test(haystack);
}

function buildBigramList(text) {
  if (text.length < 2) return text ? [text] : [];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
}

function computeContainment({ text, haystack }) {
  const bigramList = buildBigramList(normalizeNarration({ text }));
  if (!bigramList.length) return 0;
  const haystackSet = new Set(buildBigramList(normalizeNarration({ text: haystack })));
  return bigramList.filter((gram) => haystackSet.has(gram)).length / bigramList.length;
}

function isCoveredBy({ text, haystack }) {
  if (!haystack) return false;
  if (DIGIT_PATTERN.test(text)) {
    const normalizedHaystack = normalizeNumberGrouping(haystack);
    return extractNumberCoreList(text).every((core) => containsNumberCore({ haystack: normalizedHaystack, core }));
  }
  return computeContainment({ text, haystack }) >= TEXT_CONTAINMENT_THRESHOLD;
}

// lineList: 새로 뜬 줄 글. transcript: 최근 받아쓰기. narrationTextList: 최근에 낸 해설 문장.
function filterSpokenLines({ lineList = [], transcript = '', narrationTextList = [] }) {
  const narrationText = narrationTextList.filter(Boolean).join('\n');
  const keptList = [];
  let spokenCount = 0;
  let narratedCount = 0;
  for (const rawText of lineList) {
    const text = String(rawText || '').trim();
    if (!text) continue;
    if (isCoveredBy({ text, haystack: transcript })) { spokenCount += 1; continue; }
    if (isCoveredBy({ text, haystack: narrationText })) { narratedCount += 1; continue; }
    keptList.push(text);
  }
  // 값 위주로 알리게 숫자가 있는 줄을 먼저 둔다(같은 무리 안에서는 화면 순서).
  const keptLineList = [...keptList.filter((text) => DIGIT_PATTERN.test(text)), ...keptList.filter((text) => !DIGIT_PATTERN.test(text))];
  let skipReason = null;
  if (!keptLineList.length && (spokenCount || narratedCount)) {
    skipReason = spokenCount ? SPOKEN_FILTER_REASON_MAP.spoken : SPOKEN_FILTER_REASON_MAP.alreadyNarrated;
  }
  return { keptLineList, spokenCount, narratedCount, skipReason };
}

module.exports = { filterSpokenLines, SPOKEN_FILTER_REASON_MAP, TEXT_CONTAINMENT_THRESHOLD };
