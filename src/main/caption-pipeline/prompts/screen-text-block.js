// 수치·척도 해설 프롬프트에 넣는 "같은 화면을 OCR 로 읽은 글자" 덩어리. 이름·값의 철자를 확인하는 보조이고,
// 어느 글자가 어느 대상의 것인지는 이미지에서 정하게 한다(OCR 줄은 같은 높이의 다른 칸을 한 줄로 이을 수 있다).
const { GROUNDING_NONE_TOKEN } = require('../agents/shared/caption-parser');

// 글자 많은 화면도 약 450~500토큰 안에 묶이는 상한. OCR 글자는 글자당 0.65~0.84토큰이다.
const SCREEN_TEXT_MAX_CHARS = 600;

// 덩어리를 받는 해설. 둘째 안내 줄만 다르다 — 수치는 값·항목 이름을, 척도는 대상·비교 대상 이름과 적힌 크기 값을 확인한다.
const SCREEN_TEXT_USAGE_MAP = { value: 'value', scale: 'scale' };
const SCREEN_TEXT_INTRO_LINE = '참고: 아래는 같은 화면을 글자 인식기(OCR)로 읽은 글자다. 위에서 아래 순서이고, 같은 높이에 있는 다른 칸의 글자가 한 줄로 이어졌을 수 있다.';
const SCREEN_TEXT_USAGE_LINE_MAP = {
  [SCREEN_TEXT_USAGE_MAP.value]: '  값·항목 이름의 철자는 여기서 확인하되, 어느 값이 어느 항목의 것인지는 반드시 이미지에서 확인한다. 이미지와 다르면 이미지를 따른다.',
  [SCREEN_TEXT_USAGE_MAP.scale]: '  대상·비교 대상의 이름과 화면에 적힌 크기·길이 값은 여기서 확인하되, 어느 글자가 어느 대상의 것인지는 반드시 이미지에서 확인한다. 이미지와 다르면 이미지를 따른다.',
};
const QUOTE_FENCE = '"""';

const HANGUL_PATTERN = /[가-힣]/;
const DIGIT_PATTERN = /\d/;
const TOKEN_SPLIT_PATTERN = /[^0-9A-Za-z가-힣]+/;
const NUMBER_CORE_PATTERN = /\d+(?:\.\d+)?/g;
const MIN_HANGUL_WORD_LENGTH = 2;
const MIN_LATIN_WORD_LENGTH = 3;
const MIN_NUMBER_DIGIT_COUNT = 2;

// 낱말 끝의 조사. 긴 것부터 떼어 본다. 떼고 남은 말이 두 글자보다 짧으면 떼지 않는다("속도"·"나이"는 그대로).
const KOREAN_PARTICLE_LIST = [
  '에서는', '으로는', '이라는', '이라고', '에서', '으로', '보다', '부터', '까지', '처럼', '만큼', '에게', '한테',
  '라는', '라고', '에는', '로는', '와는', '과는', '이나', '이랑',
  '은', '는', '이', '가', '을', '를', '도', '의', '에', '로', '와', '과', '만', '랑',
].sort((left, right) => right.length - left.length);

const ENGLISH_STOPWORD_SET = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'this', 'that', 'these', 'those', 'from', 'has', 'have', 'had',
  'our', 'your', 'their', 'its', 'but', 'not', 'very', 'much', 'more', 'than', 'into', 'over', 'also', 'just',
  'here', 'there', 'about', 'which', 'what', 'will', 'can', 'all', 'you', 'they', 'them', 'been', 'really', 'quite',
]);

function normalizeDigitGrouping(text) {
  return String(text || '').replace(/(\d),(?=\d)/g, '$1');
}

function stripKoreanParticle(token) {
  const particle = KOREAN_PARTICLE_LIST.find((candidate) => token.endsWith(candidate)
    && token.length - candidate.length >= MIN_HANGUL_WORD_LENGTH);
  return particle ? token.slice(0, -particle.length) : token;
}

function toKeywordWord(token) {
  if (!token || DIGIT_PATTERN.test(token)) return null;
  if (HANGUL_PATTERN.test(token)) {
    const word = stripKoreanParticle(token);
    return word.length >= MIN_HANGUL_WORD_LENGTH ? word : null;
  }
  const word = token.toLowerCase();
  return word.length >= MIN_LATIN_WORD_LENGTH && !ENGLISH_STOPWORD_SET.has(word) ? word : null;
}

// 발화(와 해설이 다루는 다른 근거 표현)에서 줄 고르기에 쓸 낱말과 숫자를 뽑는다.
// 숫자는 두 자리 이상만 본다("3분기"의 3 같은 한 자리 수는 거의 모든 줄에 맞는다).
function extractKeywordList(sourceTextList = []) {
  const wordSet = new Set();
  const numberCoreSet = new Set();
  for (const sourceText of sourceTextList) {
    const normalized = normalizeDigitGrouping(sourceText);
    for (const token of normalized.split(TOKEN_SPLIT_PATTERN)) {
      const word = toKeywordWord(token);
      if (word) wordSet.add(word);
    }
    for (const core of normalized.match(NUMBER_CORE_PATTERN) || []) {
      if (core.replace(/\D/g, '').length >= MIN_NUMBER_DIGIT_COUNT) numberCoreSet.add(core);
    }
  }
  return { wordList: [...wordSet], numberCoreList: [...numberCoreSet] };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 앞뒤가 다른 숫자로 이어지면 같은 수가 아니다("79" 는 "179"·"79.5" 와 다르다).
function containsNumberCore({ text, core }) {
  return new RegExp(`(?<![\\d.])${escapeRegExp(core)}(?!\\d|\\.\\d)`).test(text);
}

function isKeywordLine({ text, wordList, numberCoreList }) {
  const lowered = text.toLowerCase();
  if (wordList.some((word) => lowered.includes(word))) return true;
  const normalized = normalizeDigitGrouping(text);
  return numberCoreList.some((core) => containsNumberCore({ text: normalized, core }));
}

function toTrimmedTextList(lineList) {
  return (Array.isArray(lineList) ? lineList : [])
    .map((line) => (typeof line?.text === 'string' ? line.text.trim() : ''))
    .filter(Boolean);
}

// 상한 안에서 ① 발화 낱말·숫자가 든 줄 → ② 숫자가 있는 줄 → ③ 나머지 순으로 고르고, 고른 줄은 원래의 위→아래 순서로 돌려준다.
// 위에서부터 자르면 글자 많은 화면 아래쪽에 있는 말한 대상의 줄이 빠진다.
function selectScreenTextLineList({ lineList, keywordSourceList = [], maxChars = SCREEN_TEXT_MAX_CHARS }) {
  const textList = toTrimmedTextList(lineList);
  const { wordList, numberCoreList } = extractKeywordList(keywordSourceList);
  const readTier = (text) => {
    if (isKeywordLine({ text, wordList, numberCoreList })) return 0;
    return DIGIT_PATTERN.test(text) ? 1 : 2;
  };
  const tierList = textList.map(readTier);
  const selectedIndexSet = new Set();
  let charCount = 0;
  for (const tier of [0, 1, 2]) {
    textList.forEach((text, index) => {
      if (tierList[index] !== tier || charCount + text.length > maxChars) return;
      selectedIndexSet.add(index);
      charCount += text.length;
    });
  }
  return textList.filter((_, index) => selectedIndexSet.has(index));
}

// isClaimToValue: 변화·비교(claim_to_value)이면 숫자 줄이 있을 때 "수치 없음" 거절을 막는 문장을 붙인다.
// 값→의미·척도에는 붙이지 않고, 말한 수가 적힌 줄을 짚어 주지도 않는다(줄이 섞이면 엉뚱한 줄을 짚는다).
function buildScreenTextBlock({ lineList, keywordSourceList = [], isClaimToValue = false,
  usage = SCREEN_TEXT_USAGE_MAP.value, maxChars = SCREEN_TEXT_MAX_CHARS }) {
  const selectedList = selectScreenTextLineList({ lineList, keywordSourceList, maxChars });
  if (!selectedList.length) return { text: '', lineCount: 0, charCount: 0, numberLineCount: 0 };
  const numberLineCount = selectedList.filter((text) => DIGIT_PATTERN.test(text)).length;
  const blockLineList = [
    SCREEN_TEXT_INTRO_LINE,
    SCREEN_TEXT_USAGE_LINE_MAP[usage] || SCREEN_TEXT_USAGE_LINE_MAP[SCREEN_TEXT_USAGE_MAP.value],
    QUOTE_FENCE, ...selectedList, QUOTE_FENCE,
    isClaimToValue && numberLineCount
      ? `화면 글자에 숫자가 있는 줄이 ${numberLineCount}개 있다. 그 숫자가 발표자가 말한 대상과 관련 있으면 "화면에 수치가 없다"는 이유로 ${GROUNDING_NONE_TOKEN} 을 내지 않는다.`
      : '',
  ].filter(Boolean);
  return {
    text: blockLineList.join('\n'),
    lineCount: selectedList.length,
    charCount: selectedList.reduce((sum, text) => sum + text.length, 0),
    numberLineCount,
  };
}

module.exports = {
  buildScreenTextBlock, selectScreenTextLineList, extractKeywordList, SCREEN_TEXT_MAX_CHARS, SCREEN_TEXT_USAGE_MAP,
};
