// 발화에서 화면 라벨과 맞춰 볼 낱말(명사·숫자+단위·영문 약어)을 뽑는다.
// 한국어는 Kiwi 품사로 뽑고, Kiwi 가 준비 전이거나 영어 문장이면 규칙(조사 떼기·숫자 경계)으로 같은 모양을 만든다.
const { extractKeywordList } = require('../../prompts/screen-text-block');
const { detectTriggerLanguage, TRIGGER_LANGUAGE_MAP } = require('../../trigger/speech-trigger');
const { normalizeLabelText } = require('./label-matcher');

const TERM_KIND_MAP = { word: 'word', acronym: 'acronym', number: 'number' };
const TERM_SOURCE_MAP = { utterance: 'utterance', after: 'after', before: 'before' };
// 트리거 문장이 가장 믿을 만하고, 뒤 발화(요청에 이미 있는 2초 창)·앞 발화의 마지막 문장 순으로 낮춘다.
const TERM_SOURCE_WEIGHT_MAP = {
  [TERM_SOURCE_MAP.utterance]: 1, [TERM_SOURCE_MAP.after]: 0.8, [TERM_SOURCE_MAP.before]: 0.6,
};
// 근거 표현(예: "이 매출 그래프") 안이나 바로 앞뒤 어절의 낱말이 가리킨 대상의 이름일 가능성이 높다.
const ANCHOR_NEAR_BOOST = 1.2;
// 앞 60초 전체는 낱말이 많아 엉뚱한 줄을 부른다. 마지막 한 문장만, 이 길이까지만 본다.
const BEFORE_SENTENCE_MAX_CHARS = 40;

// 대상의 이름이 아니라 매체·위치·발표 진행을 가리키는 말, 시간·정도 말, 지시어. 화면 어디에나 있을 수 있어 대상을 가리지 못한다.
const GENERIC_WORD_SET = new Set([
  '화면', '슬라이드', '페이지', '자료', '그래프', '차트', '도표', '도식', '그림', '사진', '이미지', '영상', '동영상', '목록', '리스트',
  '부분', '내용', '숫자', '수치', '항목', '여러분', '우리', '저희', '말씀', '생각', '경우', '이야기', '얘기', '설명', '발표',
  '오늘', '지금', '이번', '다음', '이전', '이후', '정도', '동안', '사이', '순간', '덕분', '만큼', '대신', '와중', '무렵', '즈음',
  '당시', '그때', '이때', '위쪽', '아래쪽', '왼쪽', '오른쪽', '가운데', '중간', '상단', '하단', '좌측', '우측', '여기', '거기',
  '저기', '요기', '이것', '그것', '저것', '이거', '그거', '저거', '이게', '그게', '저게', '이쪽', '그쪽', '저쪽', '이런', '그런',
  '저런', '모두', '전부', '하나', '자체', '관련', '부분적', '측면', '사항', '방법', '문제', '정말', '진짜', '이렇게', '그렇게',
]);

const NOUN_TAG_SET = new Set(['NNG', 'NNP']);
const NOUN_RUN_TAG_SET = new Set(['NNG', 'NNP', 'XSN']);
const NUMBER_FOLLOW_TAG_SET = new Set(['NNB', 'NR', 'NNG', 'SW']);
const UNIT_SYMBOL_SET = new Set(['%', '℃', '°', '$', '₩']);
// 숫자 뒤에 붙어 단위가 되는 일반명사(Kiwi 가 NNG 로 내는 것). 그 밖의 일반명사는 숫자에 붙이지 않는다("3분기매출"의 매출).
const UNIT_NOUN_SET = new Set([
  '분기', '개월', '시간', '퍼센트', '프로', '포인트', '달러', '유로', '위안', '킬로', '킬로미터', '미터', '센티', '센티미터',
  '그램', '킬로그램', '톤', '리터', '배', '세', '주년', '학년',
]);
const MAX_NUMBER_FOLLOW_COUNT = 2;
const UNIT_RULE_LIST = [
  '%', '퍼센트', '프로', '포인트', '개월', '분기', '시간', '달러', '년', '월', '일', '주', '개', '명', '원', '억', '만', '천', '조',
  '배', '건', '곳', '대', '위', '점', '회', '세',
].sort((left, right) => right.length - left.length);

const HANGUL_PATTERN = /[가-힣]/;
const HANGUL_ONLY_PATTERN = /^[가-힣]+$/;
const ACRONYM_TEXT_PATTERN = /^[A-Z]{2,6}$/;
const ENGLISH_WORD_PATTERN = /^[A-Za-z]{3,}$/;
const RULE_ACRONYM_PATTERN = /(?<![A-Za-z])[A-Z]{2,6}(?![A-Za-z])/g;
const RULE_NUMBER_PATTERN = new RegExp(`\\d+(?:,\\d{3})*(?:\\.\\d+)?(?:\\s?(?:${UNIT_RULE_LIST.join('|')}))?`, 'g');
// 규칙 대체에서 풀이말로 보는 어절 끝(보시면·늘었습니다·있고요). 명사만 남기려는 것이다.
const PREDICATE_ENDING_PATTERN = /(?:니다|어요|아요|해요|세요|지요|죠|면|고요|는데|지만|어서|아서|었다|았다|했다|한다|된다|이다)$/;
const SENTENCE_SPLIT_PATTERN = /(?<=[.?!。])\s+|\n+/;

// 앞 발화의 마지막 한 문장. 길면 끝에서 상한 길이만 남기고, 어절 중간에서 시작하지 않게 다음 어절부터 쓴다.
function pickLastSentence(text) {
  const sentenceList = String(text || '').split(SENTENCE_SPLIT_PATTERN).map((sentence) => sentence.trim()).filter(Boolean);
  const last = sentenceList.at(-1) || '';
  if (last.length <= BEFORE_SENTENCE_MAX_CHARS) return last;
  const tail = last.slice(-BEFORE_SENTENCE_MAX_CHARS);
  const isCutInWord = !/\s/.test(last[last.length - BEFORE_SENTENCE_MAX_CHARS - 1]) && !/^\s/.test(tail);
  const spaceIndex = tail.search(/\s/);
  return (isCutInWord && spaceIndex >= 0 ? tail.slice(spaceIndex) : tail).trim();
}

function isUsableWord(norm) {
  if (!norm || GENERIC_WORD_SET.has(norm)) return false;
  if (HANGUL_ONLY_PATTERN.test(norm) && norm.length < 2) return false;
  return true;
}

function isUsableNumber({ core, unit }) {
  return Boolean(unit) || core.replace(/\D/g, '').length >= 2;
}

function buildEojeolList(text) {
  return [...text.matchAll(/\S+/g)].map((found) => ({ start: found.index, end: found.index + found[0].length }));
}

function findEojeolIndex(eojeolList, position) {
  return eojeolList.findIndex((eojeol) => position >= eojeol.start && position < eojeol.end);
}

// 근거 표현이 걸친 어절과 그 앞뒤 어절의 번호 집합.
function buildNearEojeolSet({ text, eojeolList, anchor }) {
  const nearSet = new Set();
  const trimmedAnchor = String(anchor || '').trim();
  const at = trimmedAnchor ? text.indexOf(trimmedAnchor) : -1;
  if (at < 0) return nearSet;
  const end = at + trimmedAnchor.length;
  eojeolList.forEach((eojeol, index) => {
    if (eojeol.start < end && eojeol.end > at) [index - 1, index, index + 1].forEach((near) => nearSet.add(near));
  });
  return nearSet;
}

function toTerm({ text, kind, source, isNearAnchor }) {
  const surface = text.trim();
  const norm = kind === TERM_KIND_MAP.acronym ? surface.toLowerCase() : normalizeLabelText(surface);
  const weight = TERM_SOURCE_WEIGHT_MAP[source] * (isNearAnchor ? ANCHOR_NEAR_BOOST : 1);
  return { text: surface, norm, kind, weight: Math.round(weight * 1000) / 1000, source, isNearAnchor };
}

function splitNumberNorm(norm) {
  const found = /^(\d+(?:\.\d+)?)(.*)$/.exec(norm);
  return found ? { core: found[1], unit: found[2] } : { core: '', unit: '' };
}

// Kiwi 형태소로 낱말을 뽑는다. 같은 어절 안의 명사 연속·명사+접미사는 붙이고, 조사 없이 이어진 두 어절의 명사는 붙인 말도 하나 더 만든다.
function extractByKiwi({ text, tokenList, source, anchor }) {
  const eojeolList = buildEojeolList(text);
  const nearSet = source === TERM_SOURCE_MAP.utterance ? buildNearEojeolSet({ text, eojeolList, anchor }) : new Set();
  const tokenListByEojeol = eojeolList.map(() => []);
  for (const token of [...tokenList].sort((left, right) => left.start - right.start)) {
    const index = findEojeolIndex(eojeolList, token.start);
    if (index >= 0) tokenListByEojeol[index].push(token);
  }
  const termList = [];
  const push = ({ start, end, kind, eojeolIndex }) => {
    const surface = text.slice(start, end);
    const term = toTerm({ text: surface, kind, source, isNearAnchor: nearSet.has(eojeolIndex) });
    if (kind === TERM_KIND_MAP.number ? isUsableNumber(splitNumberNorm(term.norm)) : isUsableWord(term.norm)) termList.push(term);
  };
  const runByEojeol = eojeolList.map(() => ({ first: null, last: null }));
  tokenListByEojeol.forEach((eojeolTokenList, eojeolIndex) => {
    let index = 0;
    while (index < eojeolTokenList.length) {
      const token = eojeolTokenList[index];
      const isContiguous = (next, previous) => next.start <= previous.end;
      if (NOUN_TAG_SET.has(token.tag)) {
        const run = [token];
        let next = index + 1;
        while (next < eojeolTokenList.length && NOUN_RUN_TAG_SET.has(eojeolTokenList[next].tag)
          && isContiguous(eojeolTokenList[next], eojeolTokenList[next - 1])) {
          run.push(eojeolTokenList[next]);
          next += 1;
        }
        const nounPart = { start: run[0].start, end: run.at(-1).end };
        push({ ...nounPart, kind: TERM_KIND_MAP.word, eojeolIndex });
        const nounList = run.filter((item) => NOUN_TAG_SET.has(item.tag));
        if (nounList.length > 1) {
          for (const noun of nounList) push({ start: noun.start, end: noun.end, kind: TERM_KIND_MAP.word, eojeolIndex });
        }
        if (index === 0) runByEojeol[eojeolIndex].first = nounPart;
        if (next === eojeolTokenList.length) runByEojeol[eojeolIndex].last = nounPart;
        index = next;
        continue;
      }
      if (token.tag === 'SN') {
        const run = [token];
        let next = index + 1;
        while (next < eojeolTokenList.length && run.length <= MAX_NUMBER_FOLLOW_COUNT
          && isContiguous(eojeolTokenList[next], eojeolTokenList[next - 1])
          && NUMBER_FOLLOW_TAG_SET.has(eojeolTokenList[next].tag)
          && isNumberFollower(eojeolTokenList[next])) {
          run.push(eojeolTokenList[next]);
          next += 1;
        }
        push({ start: run[0].start, end: run.at(-1).end, kind: TERM_KIND_MAP.number, eojeolIndex });
        index = next;
        continue;
      }
      if (token.tag === 'SL') {
        if (ACRONYM_TEXT_PATTERN.test(token.form)) push({ start: token.start, end: token.end, kind: TERM_KIND_MAP.acronym, eojeolIndex });
        else if (ENGLISH_WORD_PATTERN.test(token.form) && isEnglishContentWord(token.form)) {
          push({ start: token.start, end: token.end, kind: TERM_KIND_MAP.word, eojeolIndex });
        }
      } else if (token.tag === 'SH') {
        push({ start: token.start, end: token.end, kind: TERM_KIND_MAP.word, eojeolIndex });
      }
      index += 1;
    }
  });
  // "서울 지역" → 서울지역. 앞 어절이 명사로 끝나고(조사 없음) 뒤 어절이 명사로 시작할 때만.
  for (let index = 0; index + 1 < eojeolList.length; index += 1) {
    const left = runByEojeol[index].last;
    const right = runByEojeol[index + 1].first;
    if (!left || !right) continue;
    const leftNorm = normalizeLabelText(text.slice(left.start, left.end));
    const rightNorm = normalizeLabelText(text.slice(right.start, right.end));
    if (!isUsableWord(leftNorm) || !isUsableWord(rightNorm)) continue;
    const term = toTerm({
      text: `${text.slice(left.start, left.end)} ${text.slice(right.start, right.end)}`, kind: TERM_KIND_MAP.word, source,
      isNearAnchor: nearSet.has(index) || nearSet.has(index + 1),
    });
    termList.push(term);
  }
  return termList;
}

function isNumberFollower(token) {
  if (token.tag === 'SW') return UNIT_SYMBOL_SET.has(token.form);
  if (token.tag === 'NNG') return UNIT_NOUN_SET.has(token.form);
  return true;
}

const ENGLISH_STOPWORD_SET = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'this', 'that', 'these', 'those', 'from', 'has', 'have', 'had',
  'our', 'your', 'their', 'its', 'but', 'not', 'very', 'much', 'more', 'than', 'into', 'over', 'also', 'just',
  'here', 'there', 'about', 'which', 'what', 'will', 'can', 'all', 'you', 'they', 'them', 'been', 'really', 'quite',
  'look', 'see', 'slide', 'chart', 'graph', 'table', 'screen', 'page', 'part', 'one', 'thing', 'number',
]);

function isEnglishContentWord(word) {
  return !ENGLISH_STOPWORD_SET.has(word.toLowerCase());
}

// 규칙 대체: 조사를 뗀 한글 낱말·영어 낱말(screen-text-block 의 규칙), 대문자 약어, 숫자+단위.
function extractByRule({ text, source, anchor }) {
  const eojeolList = buildEojeolList(text);
  const nearSet = source === TERM_SOURCE_MAP.utterance ? buildNearEojeolSet({ text, eojeolList, anchor }) : new Set();
  const isNearAt = (position) => nearSet.has(findEojeolIndex(eojeolList, position));
  const termList = [];
  const acronymSet = new Set();
  for (const found of text.matchAll(RULE_ACRONYM_PATTERN)) {
    acronymSet.add(found[0].toLowerCase());
    termList.push(toTerm({ text: found[0], kind: TERM_KIND_MAP.acronym, source, isNearAnchor: isNearAt(found.index) }));
  }
  const { wordList } = extractKeywordList([text]);
  const lowerText = text.toLowerCase();
  for (const word of wordList) {
    if (acronymSet.has(word)) continue;
    if (HANGUL_PATTERN.test(word) && PREDICATE_ENDING_PATTERN.test(word)) continue;
    if (!HANGUL_PATTERN.test(word) && !isEnglishContentWord(word)) continue;
    const term = toTerm({ text: word, kind: TERM_KIND_MAP.word, source, isNearAnchor: isNearAt(lowerText.indexOf(word)) });
    if (isUsableWord(term.norm)) termList.push(term);
  }
  for (const found of text.matchAll(RULE_NUMBER_PATTERN)) {
    const term = toTerm({ text: found[0], kind: TERM_KIND_MAP.number, source, isNearAnchor: isNearAt(found.index) });
    if (isUsableNumber(splitNumberNorm(term.norm))) termList.push(term);
  }
  return termList;
}

function extractFromText({ tokenize, text, source, anchor }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  const isKorean = detectTriggerLanguage(trimmed) === TRIGGER_LANGUAGE_MAP.ko;
  const tokenList = isKorean && typeof tokenize === 'function' ? tokenize(trimmed) : null;
  return Array.isArray(tokenList)
    ? extractByKiwi({ text: trimmed, tokenList, source, anchor })
    : extractByRule({ text: trimmed, source, anchor });
}

// 같은 말(정규화 기준)은 가중치가 높은 쪽 하나만 남긴다.
function extractSpeechTermList({ tokenize = null, utterance = '', before = '', after = '', anchor = '' }) {
  const sourceList = [
    { text: utterance, source: TERM_SOURCE_MAP.utterance },
    { text: after, source: TERM_SOURCE_MAP.after },
    { text: pickLastSentence(before), source: TERM_SOURCE_MAP.before },
  ];
  const termByNormMap = new Map();
  for (const { text, source } of sourceList) {
    for (const term of extractFromText({ tokenize, text, source, anchor })) {
      const kept = termByNormMap.get(term.norm);
      if (!kept || term.weight > kept.weight) termByNormMap.set(term.norm, term);
    }
  }
  return [...termByNormMap.values()];
}

module.exports = {
  extractSpeechTermList, pickLastSentence, TERM_KIND_MAP, TERM_SOURCE_MAP, TERM_SOURCE_WEIGHT_MAP, ANCHOR_NEAR_BOOST,
  GENERIC_WORD_SET,
};
