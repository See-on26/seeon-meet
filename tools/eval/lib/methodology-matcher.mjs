import { TARGET_TYPE_MAP, CANDIDATE_SOURCE_MAP, LANGUAGE_MAP } from './eval-types.mjs';
import {
  DEMONSTRATIVE_DETERMINER_LIST, DEMONSTRATIVE_PRONOUN_LIST, DEMONSTRATIVE_ADVERB_LIST, DEMONSTRATIVE_ADVERB_STEM_LIST,
  DEMONSTRATIVE_ADNOMINAL_LIST, ADJECTIVE_REFERENT_LIST, ADJECTIVE_LIKE_VERB_LIST,
  VALUE_UNIT_LIST, NATIVE_NUMERAL_LIST,
  CHANGE_VERB_STEM_LIST, CONCLUSION_WORD_LIST, COMPARATIVE_ADVERB,
  CHANGE_WORD_PREFIX_LIST, CHANGE_WORD_EXCLUDE_PREFIX_LIST, COMPARATIVE_ADJECTIVE_PREFIX_LIST,
  SCALE_ADJECTIVE_STEM_LIST, SCALE_WORD_LIST, PRONOUN_PARTICLE_LIST, ENGLISH_PATTERN_SOURCE_MAP,
} from './methodology-lexicon.mjs';
import { createKiwiAnalyzer } from './kiwi-analyzer.mjs';

export const MATCHER_KIND_MAP = { kiwi: 'kiwi', regex: 'regex', auto: 'auto' };

const MAX_UNIT_TOKEN_COUNT = 2;

const isAdjective = (token) => token.tag === 'VA' || token.tag.startsWith('VA-');
const isVerb = (token) => token.tag === 'VV' || token.tag.startsWith('VV-');
const isNoun = (token) => token.tag.startsWith('NN');
const tokenEnd = (token) => token.position + token.length;

function buildCandidate({ type, text, start, end, isApproximate }) {
  return {
    type, start, end, trigger: text.slice(start, end), source: CANDIDATE_SOURCE_MAP.methodology, isApproximate,
  };
}

function buildTokenCandidate({ type, text, tokenList }) {
  const start = Math.min(...tokenList.map((token) => token.position));
  const end = Math.max(...tokenList.map(tokenEnd));
  return buildCandidate({ type, text, start, end, isApproximate: false });
}

// 숫자 바로 뒤(띄어쓰기 한 칸까지)에 이어 붙은 단위 토큰.
function collectUnitTokenList({ tokenList, fromIndex, previousEnd }) {
  const unitList = [];
  let cursorEnd = previousEnd;
  for (let index = fromIndex; index < tokenList.length && unitList.length < MAX_UNIT_TOKEN_COUNT; index += 1) {
    const token = tokenList[index];
    if (token.position > cursorEnd + 1 || !VALUE_UNIT_LIST.includes(token.form)) break;
    unitList.push(token);
    cursorEnd = tokenEnd(token);
  }
  return unitList;
}

// 형용사 관형형(어간 + ㄴ/은) 바로 뒤의 쪽·부분·거·것·곳.
function isAdjectiveNounAt({ tokenList, index }) {
  const [stem, ending, referent] = tokenList.slice(index, index + 3);
  if (!stem || !ending || !referent) return false;
  const isAdjectiveStem = isAdjective(stem) || (isVerb(stem) && ADJECTIVE_LIKE_VERB_LIST.includes(stem.form));
  return isAdjectiveStem && ending.tag === 'ETM' && isNoun(referent) && ADJECTIVE_REFERENT_LIST.includes(referent.form);
}

// Kiwi 토큰({ form, tag, position, length })을 회의록 말주머니와 품사 단위로 대조한다.
export function matchKoreanTokenList({ text, tokenList }) {
  const candidateList = [];
  const push = (type, matchedList) => candidateList.push(buildTokenCandidate({ type, text, tokenList: matchedList }));
  tokenList.forEach((token, index) => {
    const next = tokenList[index + 1];
    if (token.tag === 'MM' && DEMONSTRATIVE_DETERMINER_LIST.includes(token.form)) push(TARGET_TYPE_MAP.demonstrative, [token]);
    if (token.tag === 'NP' && DEMONSTRATIVE_PRONOUN_LIST.includes(token.form)) push(TARGET_TYPE_MAP.demonstrative, [token]);
    if (token.tag === 'MAG' && DEMONSTRATIVE_ADVERB_LIST.includes(token.form)) push(TARGET_TYPE_MAP.demonstrative, [token]);
    if (isAdjective(token) && DEMONSTRATIVE_ADVERB_STEM_LIST.includes(token.form) && next?.form === '게' && next.tag === 'EC') {
      push(TARGET_TYPE_MAP.demonstrative, [token, next]);
    }
    if (isAdjectiveNounAt({ tokenList, index })) push(TARGET_TYPE_MAP.adjectiveNoun, tokenList.slice(index, index + 3));
    const isNumber = token.tag === 'SN'
      || ((token.tag === 'MM' || token.tag === 'NR') && NATIVE_NUMERAL_LIST.includes(token.form));
    if (isNumber) {
      const unitList = collectUnitTokenList({ tokenList, fromIndex: index + 1, previousEnd: tokenEnd(token) });
      if (unitList.length) push(TARGET_TYPE_MAP.value, [token, ...unitList]);
    }
    if (isVerb(token) && CHANGE_VERB_STEM_LIST.includes(token.form)) push(TARGET_TYPE_MAP.change, [token]);
    if (CONCLUSION_WORD_LIST.includes(token.form)) push(TARGET_TYPE_MAP.change, [token]);
    if (token.form === COMPARATIVE_ADVERB && token.tag === 'MAG' && next && isAdjective(next)) {
      push(TARGET_TYPE_MAP.change, [token, next]);
    }
    if (isAdjective(token) && SCALE_ADJECTIVE_STEM_LIST.includes(token.form)) push(TARGET_TYPE_MAP.scale, [token]);
  });
  return candidateList;
}

const LEADING_PUNCTUATION_PATTERN = /^[("'“‘[]+/;
const TRAILING_PUNCTUATION_PATTERN = /[.,!?…)"'”’\]]+$/;

// 어절(띄어쓰기 단위)마다 앞뒤 문장 부호를 뗀 낱말과 위치.
export function listWord(text) {
  const wordList = [];
  for (const match of text.matchAll(/\S+/g)) {
    const leading = match[0].match(LEADING_PUNCTUATION_PATTERN)?.[0].length || 0;
    const stripped = match[0].slice(leading).replace(TRAILING_PUNCTUATION_PATTERN, '');
    if (!stripped) continue;
    const start = match.index + leading;
    wordList.push({ word: stripped, start, end: start + stripped.length });
  }
  return wordList;
}

const longestPrefix = (word, prefixList) => prefixList
  .filter((prefix) => word.startsWith(prefix))
  .sort((prefixA, prefixB) => prefixB.length - prefixA.length)[0] || null;

const HANGUL_BASE_CODE = 0xac00;
const HANGUL_LAST_CODE = 0xd7a3;
const JONGSEONG_COUNT = 28;
const JONGSEONG_NIEUN_INDEX = 4;

// 마지막 글자 받침이 ㄴ 인지(빨간·싼·큰·작은). 품사 없이 형용사 관형형을 어림하는 근거다.
export function hasNieunFinal(word) {
  const code = word.charCodeAt(word.length - 1);
  if (code < HANGUL_BASE_CODE || code > HANGUL_LAST_CODE) return false;
  return (code - HANGUL_BASE_CODE) % JONGSEONG_COUNT === JONGSEONG_NIEUN_INDEX;
}

const VALUE_PATTERN = new RegExp(`\\d[\\d,.]*\\s?(?:${VALUE_UNIT_LIST.join('|')})`, 'g');

// Kiwi 를 못 쓸 때의 한국어 근사: 어절 경계와 낱말 목록으로 대조한다. 결과에 isApproximate 를 붙인다.
export function matchKoreanRegex({ text }) {
  const candidateList = [];
  const push = (type, start, end) => candidateList.push(buildCandidate({ type, text, start, end, isApproximate: true }));
  const wordList = listWord(text);
  wordList.forEach((entry, index) => {
    const { word, start, end } = entry;
    const next = wordList[index + 1];
    if (DEMONSTRATIVE_DETERMINER_LIST.includes(word) && next) push(TARGET_TYPE_MAP.demonstrative, start, end);
    const pronoun = longestPrefix(word, DEMONSTRATIVE_PRONOUN_LIST);
    if (pronoun && PRONOUN_PARTICLE_LIST.includes(word.slice(pronoun.length))) {
      push(TARGET_TYPE_MAP.demonstrative, start, start + pronoun.length);
    }
    const adverb = longestPrefix(word, DEMONSTRATIVE_ADVERB_LIST);
    if (adverb) push(TARGET_TYPE_MAP.demonstrative, start, start + adverb.length);
    const referent = next ? longestPrefix(next.word, ADJECTIVE_REFERENT_LIST) : null;
    const isAdjectiveNoun = referent && next.start === end + 1 && PRONOUN_PARTICLE_LIST.includes(next.word.slice(referent.length))
      && hasNieunFinal(word) && !DEMONSTRATIVE_ADNOMINAL_LIST.includes(word) && !NATIVE_NUMERAL_LIST.includes(word);
    if (isAdjectiveNoun) push(TARGET_TYPE_MAP.adjectiveNoun, start, next.start + referent.length);
    if (NATIVE_NUMERAL_LIST.includes(word) && next && longestPrefix(next.word, VALUE_UNIT_LIST) && next.start === end + 1) {
      push(TARGET_TYPE_MAP.value, start, next.start + longestPrefix(next.word, VALUE_UNIT_LIST).length);
    }
    const isExcludedChange = CHANGE_WORD_EXCLUDE_PREFIX_LIST.some((prefix) => word.startsWith(prefix));
    const change = isExcludedChange ? null : longestPrefix(word, CHANGE_WORD_PREFIX_LIST);
    if (change) push(TARGET_TYPE_MAP.change, start, start + change.length);
    if (word === COMPARATIVE_ADVERB && next && longestPrefix(next.word, COMPARATIVE_ADJECTIVE_PREFIX_LIST)) {
      push(TARGET_TYPE_MAP.change, start, next.end);
    }
    if (SCALE_WORD_LIST.includes(word)) push(TARGET_TYPE_MAP.scale, start, end);
  });
  for (const match of text.matchAll(VALUE_PATTERN)) push(TARGET_TYPE_MAP.value, match.index, match.index + match[0].length);
  return candidateList.sort((candidateA, candidateB) => candidateA.start - candidateB.start);
}

const ENGLISH_PATTERN_LIST = [
  [TARGET_TYPE_MAP.demonstrative, ENGLISH_PATTERN_SOURCE_MAP.demonstrative],
  [TARGET_TYPE_MAP.adjectiveNoun, ENGLISH_PATTERN_SOURCE_MAP.adjectiveNoun],
  [TARGET_TYPE_MAP.value, ENGLISH_PATTERN_SOURCE_MAP.value],
  [TARGET_TYPE_MAP.change, ENGLISH_PATTERN_SOURCE_MAP.change],
  [TARGET_TYPE_MAP.scale, ENGLISH_PATTERN_SOURCE_MAP.scale],
];

// 영어는 단어 경계·대소문자 무시로 대조한다. 회의록 방법 그대로라 근사가 아니다.
export function matchEnglishLexicon({ text }) {
  const candidateList = [];
  for (const [type, source] of ENGLISH_PATTERN_LIST) {
    for (const match of text.matchAll(new RegExp(source, 'gi'))) {
      candidateList.push(buildCandidate({ type, text, start: match.index, end: match.index + match[0].length, isApproximate: false }));
    }
  }
  return candidateList.sort((candidateA, candidateB) => candidateA.start - candidateB.start);
}

function buildMatcher({ koreanKind, isKoreanApproximate, version, matchKorean }) {
  return {
    kind: koreanKind,
    isApproximate: isKoreanApproximate,
    version,
    match: ({ text, language = LANGUAGE_MAP.ko }) => (language === LANGUAGE_MAP.en ? matchEnglishLexicon({ text }) : matchKorean({ text })),
  };
}

// Kiwi 없이 쓰는 매처. 한국어는 어절 근사, 영어는 단어 경계 대조다.
export const REGEX_MATCHER = Object.freeze(buildMatcher({
  koreanKind: MATCHER_KIND_MAP.regex, isKoreanApproximate: true, version: null, matchKorean: matchKoreanRegex,
}));

// 한국어는 Kiwi(없으면 근사), 영어는 단어 경계 대조. kind 는 한국어 쪽 매처 이름이다.
export async function createMethodologyMatcher({
  kind = MATCHER_KIND_MAP.auto, createAnalyzer = createKiwiAnalyzer, onWarn = (message) => console.warn(message),
} = {}) {
  if (kind === MATCHER_KIND_MAP.regex) return REGEX_MATCHER;
  try {
    const analyzer = await createAnalyzer();
    return buildMatcher({
      koreanKind: MATCHER_KIND_MAP.kiwi,
      isKoreanApproximate: false,
      version: analyzer.version,
      matchKorean: ({ text }) => matchKoreanTokenList({ text, tokenList: analyzer.analyze(text) }),
    });
  } catch (error) {
    if (kind === MATCHER_KIND_MAP.kiwi) throw error;
    onWarn(`[eval] Kiwi 를 쓸 수 없어 한국어는 어절 경계 정규식으로 근사한다: ${error.message}`);
    return REGEX_MATCHER;
  }
}
