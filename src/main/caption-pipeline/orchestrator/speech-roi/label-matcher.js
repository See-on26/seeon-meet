// 발화 낱말을 화면 OCR 줄과 맞추고, 확대할 줄을 고른다.
// 줄 글은 위치를 찾는 데만 쓴다. 맞춘 결과(줄 글)를 지시 프롬프트에 넣지 않는다 — 옆 칸 글자를 대상에 붙인 회귀가 있었다.
const { ALIAS_GROUP_LIST, readAcronymReadingList } = require('./label-alias');

const MATCH_KIND_MAP = {
  exact: 'exact',
  latin: 'latin',
  contains: 'contains',
  reverseContains: 'reverse_contains',
  number: 'number',
  year: 'year',
  acronymReading: 'acronym_reading',
  alias: 'alias',
  jamo: 'jamo',
};

const MATCH_SCORE_MAP = {
  exact: 1,
  latin: 1,
  contains: 0.85,
  containsShortInLong: 0.7,
  reverseContains: 0.7,
  numberWithUnit: 0.9,
  numberLong: 0.75,
  numberShort: 0.5,
  year: 0.75,
  acronymReading: 0.8,
  alias: 0.8,
  jamo: 0.6,
};

const ROI_SELECT_STATUS_MAP = { selected: 'selected', noTerms: 'no_terms', noMatch: 'no_match', titleOnly: 'title_only' };
const TARGET_ROLE_MAP = { primary: 'primary', peer: 'peer', second: 'second' };

// 받아들이는 최저 줄 점수.
const MIN_TARGET_SCORE = 0.6;
// OCR 줄 점수가 이보다 낮으면 작은 글씨 오독일 수 있어 줄 점수를 낮춘다.
const LOW_LINE_SCORE = 0.6;
const LOW_LINE_SCORE_FACTOR = 0.7;
// 같은 낱말이 맞은 줄 수에 따른 변별력. 4줄 이상이면 그 낱말은 버린다.
const DISTINCT_FACTOR_LIST = [1, 1, 0.8, 0.6];
const MAX_DISTINCT_LINE_COUNT = 3;
// 4줄 이상 맞은 줄들이 이 면적 안에 모여 있으면(표의 한 열) 묶음 상자 하나를 후보로 쓴다.
const MAX_CLUSTER_AREA = 0.25;
// 같은 줄에 다른 낱말이 더 맞을 때 더하는 점수(최대 2개). 두 자리 맨숫자는 동점을 가르는 데만 쓴다.
const EXTRA_TERM_BONUS = 0.2;
const TIE_BREAK_BONUS = 0.05;
const MAX_EXTRA_TERM_COUNT = 2;
// 화면 위 18% 안의 큰 줄은 제목으로 보고 낮춘다. 제목은 이미 크게 읽힌다.
const TITLE_TOP_RATIO = 0.18;
const TITLE_HEIGHT_RATIO = 1.4;
const TITLE_FACTOR = 0.5;
// 2등이 1등의 이 배 이상이고 두 줄 중심이 이만큼 넘게 떨어져 있으면 애매하다.
const AMBIGUOUS_SCORE_RATIO = 0.85;
const AMBIGUOUS_DISTANCE = 0.2;

const MIN_HANGUL_TERM_LENGTH = 2;
const SHORT_TERM_LENGTH = 2;
const LONG_WORD_LENGTH = 5;
const REVERSE_CONTAINS_MIN_RATIO = 0.6;
const JAMO_MIN_TERM_LENGTH = 3;
const JAMO_MIN_SIMILARITY = 0.8;

const PUNCTUATION_CHAR_SET = new Set([...'·•ㆍ,:;!?\'"“”‘’()[]{}<>/\\|_-–—~…■□▪▶►◆◇★☆※*#']);
const HANGUL_SYLLABLE_PATTERN = /[가-힣]/;
const HANGUL_ONLY_PATTERN = /^[가-힣]+$/;
const LATIN_PATTERN = /[a-z]/;
const DIGIT_CHAR_PATTERN = /\d/;
const ACRONYM_PATTERN = /(?<![A-Za-z])[A-Z]{2,6}(?![A-Za-z])/g;
const NUMBER_TERM_PATTERN = /^(\d+(?:\.\d+)?)(.*)$/;
const PERCENT_WORD_PATTERN = /(?<=\d)\s*(?:퍼센트|프로(?![가-힣]))/g;
const APOSTROPHE_YEAR_PREFIX = "['’‘]";

// 줄 낱말 끝의 조사. 떼고 남은 말이 두 글자보다 짧으면 떼지 않는다.
const KOREAN_PARTICLE_LIST = [
  '에서는', '으로는', '이라는', '에서', '으로', '보다', '부터', '까지', '처럼', '만큼', '에게', '라는', '에는', '로는',
  '은', '는', '이', '가', '을', '를', '도', '의', '에', '로', '와', '과', '만',
].sort((left, right) => right.length - left.length);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 글자마다 원래 줄에서의 위치(start·end)를 함께 들고 다닌다. NFKC 로 글자가 늘어도 원래 위치로 돌아갈 수 있다.
function toCharList(text) {
  const charList = [];
  const source = String(text ?? '');
  let index = 0;
  for (const codePoint of source) {
    const start = index;
    index += codePoint.length;
    const normalized = codePoint.normalize('NFKC').toLowerCase();
    for (let unit = 0; unit < normalized.length; unit += 1) charList.push({ ch: normalized[unit], start, end: index });
  }
  return charList;
}

function joinCharList(charList) {
  return charList.map((item) => item.ch).join('');
}

function replaceInCharList(charList, pattern, replacement) {
  const joined = joinCharList(charList);
  const resultList = [];
  let cursor = 0;
  for (const found of joined.matchAll(pattern)) {
    resultList.push(...charList.slice(cursor, found.index));
    const first = charList[found.index];
    const last = charList[found.index + found[0].length - 1];
    for (const ch of replacement) resultList.push({ ch, start: first.start, end: last.end });
    cursor = found.index + found[0].length;
  }
  resultList.push(...charList.slice(cursor));
  return resultList;
}

const isDigitChar = (item) => Boolean(item) && DIGIT_CHAR_PATTERN.test(item.ch);

// 숫자를 볼 글: 공백은 남기고 자릿점만 지운다("1,234"→"1234"). 숫자 뒤 퍼센트·프로는 %로 바꾼다.
function buildSpacedView(text) {
  const charList = toCharList(text).filter((item, index, list) => !(item.ch === ','
    && isDigitChar(list[index - 1]) && isDigitChar(list[index + 1])));
  const replaced = replaceInCharList(charList, PERCENT_WORD_PATTERN, '%');
  return { text: joinCharList(replaced), charList: replaced };
}

// 낱말을 볼 글: 공백·문장부호를 지운다(숫자 안의 소수점은 남김). 띄어쓰기 차이("매출 액"/"매출액")가 사라진다.
function buildCompactView(text) {
  const charList = toCharList(text);
  const keptList = charList.filter((item, index) => {
    if (/\s/.test(item.ch)) return false;
    if (item.ch === '.') return isDigitChar(charList[index - 1]) && isDigitChar(charList[index + 1]);
    return !PUNCTUATION_CHAR_SET.has(item.ch);
  });
  const replaced = replaceInCharList(keptList, PERCENT_WORD_PATTERN, '%');
  return { text: joinCharList(replaced), charList: replaced };
}

function normalizeLabelText(text) {
  return buildCompactView(text).text;
}

function stripKoreanParticle(word) {
  if (!HANGUL_SYLLABLE_PATTERN.test(word)) return word;
  const particle = KOREAN_PARTICLE_LIST.find((candidate) => word.endsWith(candidate)
    && word.length - candidate.length >= MIN_HANGUL_TERM_LENGTH);
  return particle ? word.slice(0, -particle.length) : word;
}

const countHangul = (text) => (String(text).match(/[가-힣]/g) || []).length;

// 줄을 한 번만 풀어 둔다(낱말 여러 개를 같은 줄에 맞춰 본다).
const preparedLineMap = new WeakMap();

function prepareLine(line) {
  const cached = preparedLineMap.get(line);
  if (cached) return cached;
  const text = String(line?.text ?? '');
  const spaced = buildSpacedView(text);
  const compact = buildCompactView(text);
  const wordList = [];
  for (const found of text.matchAll(/\S+/g)) {
    const raw = found[0];
    const view = buildCompactView(raw);
    if (!view.charList.length) continue;
    const norm = stripKoreanParticle(view.text);
    const first = view.charList[0];
    const last = view.charList[Math.min(norm.length, view.charList.length) - 1];
    wordList.push({ norm, rawNorm: view.text, start: found.index + first.start, end: found.index + last.end });
  }
  const acronymList = [...text.normalize('NFKC').matchAll(ACRONYM_PATTERN)]
    .map((found) => ({ text: found[0], start: found.index, end: found.index + found[0].length }));
  const prepared = { text, spaced, compact, wordList, acronymList };
  if (line && typeof line === 'object') preparedLineMap.set(line, prepared);
  return prepared;
}

function toSpan(charList, startIndex, length) {
  return { charStart: charList[startIndex].start, charEnd: charList[startIndex + length - 1].end };
}

function findBoundedLatin({ spaced, phrase }) {
  const pattern = new RegExp(`(?<![a-z0-9])${phrase.split(/\s+/).map(escapeRegExp).join('\\s*')}(?![a-z0-9])`);
  const found = pattern.exec(spaced.text);
  return found ? toSpan(spaced.charList, found.index, found[0].length) : null;
}

const isWordStart = (text, index) => index === 0 || /[\s·•ㆍ,:;!?'"“”‘’()[\]{}<>/\\|_\-–—~…]/.test(text[index - 1]);

// 정규화한 줄 안의 한글 포함 맞춤. 어절을 건너는 맞춤은 어절 처음에서 시작할 때만 받는다("도서 울산" 안의 "서울"은 아니다).
function findCompactHangul({ prepared, norm }) {
  const { compact, text } = prepared;
  let fromIndex = 0;
  while (fromIndex <= compact.text.length - norm.length) {
    const at = compact.text.indexOf(norm, fromIndex);
    if (at < 0) return null;
    const span = toSpan(compact.charList, at, norm.length);
    const isDigitBefore = DIGIT_CHAR_PATTERN.test(norm[0]) && at > 0 && DIGIT_CHAR_PATTERN.test(compact.text[at - 1]);
    const crossesWord = /\s/.test(text.slice(span.charStart, span.charEnd));
    if (!isDigitBefore && (!crossesWord || isWordStart(text, span.charStart))) return span;
    fromIndex = at + 1;
  }
  return null;
}

function findContainingWord(prepared, charStart) {
  return prepared.wordList.find((word) => charStart >= word.start && charStart < word.end) || null;
}

function readTermInfo(term) {
  const norm = String(term?.norm ?? normalizeLabelText(term?.text));
  const numberMatch = term?.kind === 'number' ? NUMBER_TERM_PATTERN.exec(norm) : null;
  return {
    norm,
    isHangul: HANGUL_SYLLABLE_PATTERN.test(norm),
    isLatin: LATIN_PATTERN.test(norm) && !HANGUL_SYLLABLE_PATTERN.test(norm),
    numberCore: numberMatch ? numberMatch[1] : null,
    numberUnit: numberMatch ? numberMatch[2] : '',
  };
}

function matchNumber({ info, prepared }) {
  const { spaced } = prepared;
  const { numberCore: core, numberUnit: unit } = info;
  const digitCount = core.replace(/\D/g, '').length;
  let best = null;
  const keep = (candidate) => { if (candidate && (!best || candidate.score > best.score)) best = candidate; };
  const pattern = new RegExp(`(?<![\\d.])${escapeRegExp(core)}(?!\\d|\\.\\d)`, 'g');
  for (const found of spaced.text.matchAll(pattern)) {
    const afterIndex = found.index + core.length;
    const restText = spaced.text.slice(afterIndex);
    const gap = restText.length - restText.trimStart().length;
    if (unit && restText.trimStart().startsWith(unit)) {
      keep({ kind: MATCH_KIND_MAP.number, score: MATCH_SCORE_MAP.numberWithUnit, ...toSpan(spaced.charList, found.index, core.length + gap + unit.length) });
    } else if (digitCount >= 3) {
      keep({ kind: MATCH_KIND_MAP.number, score: MATCH_SCORE_MAP.numberLong, ...toSpan(spaced.charList, found.index, core.length) });
    } else if (digitCount === 2) {
      keep({ kind: MATCH_KIND_MAP.number, score: MATCH_SCORE_MAP.numberShort, isTieBreakOnly: true, ...toSpan(spaced.charList, found.index, core.length) });
    }
  }
  // "24년" ↔ 줄의 "2024"·"'24"
  if (unit === '년' && /^\d{2}$/.test(core)) {
    const fullYear = new RegExp(`(?<![\\d.])20${core}(?!\\d)`).exec(spaced.text);
    if (fullYear) keep({ kind: MATCH_KIND_MAP.year, score: MATCH_SCORE_MAP.year, ...toSpan(spaced.charList, fullYear.index, fullYear[0].length) });
    const shortYear = new RegExp(`${APOSTROPHE_YEAR_PREFIX}${core}(?!\\d)`).exec(prepared.text);
    if (shortYear) keep({ kind: MATCH_KIND_MAP.year, score: MATCH_SCORE_MAP.year, charStart: shortYear.index, charEnd: shortYear.index + shortYear[0].length });
  }
  return best;
}

const aliasGroupByNormMap = new Map();
for (const group of ALIAS_GROUP_LIST) {
  for (const member of group) aliasGroupByNormMap.set(normalizeLabelText(member), group);
}

function matchAlias({ info, prepared }) {
  const group = aliasGroupByNormMap.get(info.norm);
  if (!group) return null;
  for (const member of group) {
    const memberNorm = normalizeLabelText(member);
    if (memberNorm === info.norm) continue;
    const span = HANGUL_SYLLABLE_PATTERN.test(memberNorm)
      ? (countHangul(memberNorm) >= MIN_HANGUL_TERM_LENGTH ? findCompactHangul({ prepared, norm: memberNorm }) : null)
      : findBoundedLatin({ spaced: prepared.spaced, phrase: member.toLowerCase() });
    if (span) return { kind: MATCH_KIND_MAP.alias, score: MATCH_SCORE_MAP.alias, ...span };
  }
  return null;
}

function matchAcronymReading({ term, info, prepared }) {
  if (term?.kind === 'acronym') {
    for (const reading of readAcronymReadingList(term.text)) {
      const span = findCompactHangul({ prepared, norm: reading });
      if (span) return { kind: MATCH_KIND_MAP.acronymReading, score: MATCH_SCORE_MAP.acronymReading, ...span };
    }
  }
  if (info.isHangul && HANGUL_ONLY_PATTERN.test(info.norm)) {
    const acronym = prepared.acronymList.find((item) => readAcronymReadingList(item.text).includes(info.norm));
    if (acronym) {
      return { kind: MATCH_KIND_MAP.acronymReading, score: MATCH_SCORE_MAP.acronymReading, charStart: acronym.start, charEnd: acronym.end };
    }
  }
  return null;
}

const HANGUL_BASE = 0xac00;
const JUNG_COUNT = 21;
const JONG_COUNT = 28;

function toJamoList(text) {
  const jamoList = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0) - HANGUL_BASE;
    if (code < 0 || code > 11171) {
      jamoList.push(ch);
      continue;
    }
    const jong = code % JONG_COUNT;
    jamoList.push(`c${Math.floor(code / (JUNG_COUNT * JONG_COUNT))}`, `v${Math.floor((code % (JUNG_COUNT * JONG_COUNT)) / JONG_COUNT)}`);
    if (jong) jamoList.push(`f${jong}`);
  }
  return jamoList;
}

function editDistance(leftList, rightList) {
  let previousRow = Array.from({ length: rightList.length + 1 }, (_, index) => index);
  for (let i = 1; i <= leftList.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= rightList.length; j += 1) {
      row[j] = Math.min(previousRow[j] + 1, row[j - 1] + 1, previousRow[j - 1] + (leftList[i - 1] === rightList[j - 1] ? 0 : 1));
    }
    previousRow = row;
  }
  return previousRow[rightList.length];
}

// 자모로 풀어 편집 거리로 잰 유사도(0~1). 받아쓰기·OCR 오독("매출액"/"매츨액")을 잡는다.
function jamoSimilarity(left, right) {
  const leftList = toJamoList(left);
  const rightList = toJamoList(right);
  const maxLength = Math.max(leftList.length, rightList.length);
  return maxLength ? 1 - editDistance(leftList, rightList) / maxLength : 0;
}

function matchJamo({ info, prepared }) {
  if (!HANGUL_ONLY_PATTERN.test(info.norm) || info.norm.length < JAMO_MIN_TERM_LENGTH) return null;
  let best = null;
  for (const word of prepared.wordList) {
    if (!HANGUL_ONLY_PATTERN.test(word.norm) || Math.abs(word.norm.length - info.norm.length) > 1) continue;
    const similarity = jamoSimilarity(info.norm, word.norm);
    if (similarity >= JAMO_MIN_SIMILARITY && (!best || similarity > best.similarity)) {
      best = { kind: MATCH_KIND_MAP.jamo, score: MATCH_SCORE_MAP.jamo, isFuzzy: true, similarity, charStart: word.start, charEnd: word.end };
    }
  }
  return best;
}

// 낱말 하나를 줄 하나에 맞춘다. 맞는 방법이 여럿이면 점수가 가장 높은 것을 돌려준다. charStart·charEnd 는 원래 줄 글자 위치다.
function matchTermInLine({ term, line }) {
  const info = readTermInfo(term);
  if (!info.norm) return null;
  const prepared = prepareLine(line);
  const candidateList = [];
  if (info.numberCore) {
    candidateList.push(matchNumber({ info, prepared }));
  } else if (!info.isLatin) {
    const exactWord = prepared.wordList.find((item) => item.norm === info.norm || item.rawNorm === info.norm);
    if (exactWord) candidateList.push({ kind: MATCH_KIND_MAP.exact, score: MATCH_SCORE_MAP.exact, charStart: exactWord.start, charEnd: exactWord.end });
  }
  if (info.isLatin && !info.numberCore) {
    const span = findBoundedLatin({ spaced: prepared.spaced, phrase: info.norm });
    if (span) candidateList.push({ kind: MATCH_KIND_MAP.latin, score: MATCH_SCORE_MAP.latin, ...span });
  }
  if (info.isHangul && !info.numberCore && countHangul(info.norm) >= MIN_HANGUL_TERM_LENGTH) {
    const span = findCompactHangul({ prepared, norm: info.norm });
    if (span) {
      const word = findContainingWord(prepared, span.charStart);
      const isShortInLong = countHangul(info.norm) <= SHORT_TERM_LENGTH && word && countHangul(word.rawNorm) >= LONG_WORD_LENGTH;
      candidateList.push({
        kind: MATCH_KIND_MAP.contains, score: isShortInLong ? MATCH_SCORE_MAP.containsShortInLong : MATCH_SCORE_MAP.contains, ...span,
      });
    }
    const reverseWord = prepared.wordList.find((word) => countHangul(word.norm) >= MIN_HANGUL_TERM_LENGTH
      && HANGUL_ONLY_PATTERN.test(word.norm) && word.norm !== info.norm && info.norm.includes(word.norm)
      && word.norm.length / info.norm.length >= REVERSE_CONTAINS_MIN_RATIO);
    if (reverseWord) {
      candidateList.push({ kind: MATCH_KIND_MAP.reverseContains, score: MATCH_SCORE_MAP.reverseContains, charStart: reverseWord.start, charEnd: reverseWord.end });
    }
  }
  candidateList.push(matchAcronymReading({ term, info, prepared }), matchAlias({ info, prepared }));
  if (!candidateList.some(Boolean)) candidateList.push(matchJamo({ info, prepared }));
  return candidateList.filter(Boolean).reduce((best, candidate) => (!best || candidate.score > best.score ? candidate : best), null);
}

const rectCenter = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
const centerDistance = (left, right) => {
  const a = rectCenter(left);
  const b = rectCenter(right);
  return Math.hypot(a.x - b.x, a.y - b.y);
};

function unionRect(rectList) {
  const x0 = Math.min(...rectList.map((rect) => rect.x));
  const y0 = Math.min(...rectList.map((rect) => rect.y));
  const x1 = Math.max(...rectList.map((rect) => rect.x + rect.w));
  const y1 = Math.max(...rectList.map((rect) => rect.y + rect.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function median(valueList) {
  if (!valueList.length) return 0;
  const sorted = [...valueList].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const isRectLine = (line) => line && typeof line.text === 'string' && line.text.trim() && line.rect
  && [line.rect.x, line.rect.y, line.rect.w, line.rect.h].every(Number.isFinite);

// 두 낱말이 같은 말의 일부면(서울 ⊂ 서울지역) 같은 줄의 "다른 낱말" 덤을 주지 않는다.
const isOverlappingNorm = (left, right) => left.includes(right) || right.includes(left);

// 발화 낱말 목록과 화면 줄(비율 좌표 rect) 목록에서 확대할 대상 줄을 고른다.
// 대상이 둘인 해설(지시 완전형·둘째 주장)은 maxTargetCount=2 로 서로 다른 낱말로 맞은 줄 둘까지 고른다.
function selectRoiTarget({ termList = [], lineList = [], maxTargetCount = 1 }) {
  const emptyAmbiguity = { isAmbiguous: false, ratio: null, distance: null };
  if (!termList.length) return { status: ROI_SELECT_STATUS_MAP.noTerms, targetList: [], ambiguity: emptyAmbiguity, candidateCount: 0 };
  const usableLineList = lineList.filter(isRectLine);
  const medianHeight = median(usableLineList.map((line) => line.rect.h));
  const isTitleLine = (line) => line.rect.y < TITLE_TOP_RATIO && medianHeight > 0 && line.rect.h >= TITLE_HEIGHT_RATIO * medianHeight;

  const entryListByLineMap = new Map();
  const clusterList = [];
  for (const term of termList) {
    let matchList = usableLineList
      .map((line, lineIndex) => ({ line, lineIndex, match: matchTermInLine({ term, line }) }))
      .filter((item) => item.match);
    const fuzzyCount = matchList.filter((item) => item.match.isFuzzy).length;
    if (fuzzyCount > 1) matchList = matchList.filter((item) => !item.match.isFuzzy);
    const decisiveList = matchList.filter((item) => !item.match.isTieBreakOnly);
    if (decisiveList.length > MAX_DISTINCT_LINE_COUNT) {
      const rect = unionRect(decisiveList.map((item) => item.line.rect));
      if (rect.w * rect.h <= MAX_CLUSTER_AREA) {
        const bestScore = Math.max(...decisiveList.map((item) => item.match.score));
        clusterList.push({
          isCluster: true, line: { text: decisiveList.map((item) => item.line.text).join(' / '), rect, score: null },
          lineIndex: null, rect, term, match: decisiveList[0].match,
          score: bestScore * term.weight * DISTINCT_FACTOR_LIST[MAX_DISTINCT_LINE_COUNT],
          isTitle: false, termNormList: [term.norm], spanList: [],
        });
      }
      continue;
    }
    const distinctFactor = DISTINCT_FACTOR_LIST[decisiveList.length] ?? 0;
    for (const item of matchList) {
      const entryList = entryListByLineMap.get(item.lineIndex) || [];
      entryList.push({ term, match: item.match, value: item.match.score * term.weight * distinctFactor });
      entryListByLineMap.set(item.lineIndex, entryList);
    }
  }

  const candidateList = [...clusterList];
  for (const [lineIndex, entryList] of entryListByLineMap) {
    const line = usableLineList[lineIndex];
    const decisiveList = entryList.filter((entry) => !entry.match.isTieBreakOnly);
    if (!decisiveList.length) continue;
    const primary = decisiveList.reduce((best, entry) => (entry.value > best.value ? entry : best));
    const extraCount = Math.min(MAX_EXTRA_TERM_COUNT, decisiveList
      .filter((entry) => entry !== primary && !isOverlappingNorm(entry.term.norm, primary.term.norm)).length);
    const tieBreakCount = Math.min(MAX_EXTRA_TERM_COUNT, entryList.filter((entry) => entry.match.isTieBreakOnly).length);
    const isTitle = isTitleLine(line);
    const lineFactor = Number.isFinite(line.score) && line.score < LOW_LINE_SCORE ? LOW_LINE_SCORE_FACTOR : 1;
    candidateList.push({
      isCluster: false, line, lineIndex, rect: line.rect, term: primary.term, match: primary.match, isTitle,
      score: (primary.value + EXTRA_TERM_BONUS * extraCount + TIE_BREAK_BONUS * tieBreakCount) * lineFactor * (isTitle ? TITLE_FACTOR : 1),
      termNormList: entryList.map((entry) => entry.term.norm),
      spanList: entryList.map((entry) => ({ charStart: entry.match.charStart, charEnd: entry.match.charEnd })),
    });
  }
  const sortedList = candidateList
    .map((candidate, order) => ({ ...candidate, order }))
    .sort((left, right) => (right.score - left.score) || ((left.lineIndex ?? -1) - (right.lineIndex ?? -1)) || (left.order - right.order));
  const toResult = (status, targetList = [], ambiguity = emptyAmbiguity) => ({
    status, targetList, ambiguity, candidateCount: sortedList.length,
  });
  if (!sortedList.length) return toResult(ROI_SELECT_STATUS_MAP.noMatch);
  if (sortedList.every((candidate) => candidate.isTitle)) return toResult(ROI_SELECT_STATUS_MAP.titleOnly);
  const [best] = sortedList;
  if (best.score < MIN_TARGET_SCORE) return toResult(ROI_SELECT_STATUS_MAP.noMatch);
  const restList = sortedList.slice(1);

  if (maxTargetCount >= 2) {
    const second = restList.find((candidate) => candidate.score >= MIN_TARGET_SCORE
      && !isOverlappingNorm(candidate.term.norm, best.term.norm) && !candidate.termNormList.includes(best.term.norm));
    if (second) {
      return toResult(ROI_SELECT_STATUS_MAP.selected, [{ ...best, role: TARGET_ROLE_MAP.primary }, { ...second, role: TARGET_ROLE_MAP.second }]);
    }
  }
  const runnerUp = restList[0];
  if (runnerUp && runnerUp.score >= AMBIGUOUS_SCORE_RATIO * best.score) {
    const distance = centerDistance(best.rect, runnerUp.rect);
    return toResult(ROI_SELECT_STATUS_MAP.selected, [{ ...best, role: TARGET_ROLE_MAP.primary }, { ...runnerUp, role: TARGET_ROLE_MAP.peer }], {
      isAmbiguous: distance > AMBIGUOUS_DISTANCE, ratio: runnerUp.score / best.score, distance,
    });
  }
  return toResult(ROI_SELECT_STATUS_MAP.selected, [{ ...best, role: TARGET_ROLE_MAP.primary }], {
    isAmbiguous: false, ratio: runnerUp ? runnerUp.score / best.score : null, distance: null,
  });
}

module.exports = {
  normalizeLabelText, matchTermInLine, selectRoiTarget, jamoSimilarity, stripKoreanParticle, unionRect, centerDistance,
  MATCH_KIND_MAP, MATCH_SCORE_MAP, ROI_SELECT_STATUS_MAP, TARGET_ROLE_MAP, MIN_TARGET_SCORE, LOW_LINE_SCORE, LOW_LINE_SCORE_FACTOR,
};
