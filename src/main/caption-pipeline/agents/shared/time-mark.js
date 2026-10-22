// 해설 칸 낱말이 시점(연도·반기·분기·월·주·날짜)인지 가린다. 예산 맞추기에서 대상 칸 꾸밈말을 뺄 때 시점은 남기고,
// 근거 칸(지시 seen, 수치 source)에 하나뿐인 시점이 읽히는 칸에서 빠졌으면 되살리는 데 쓴다.
const YEAR_CORE = '(?:19|20)\\d{2}';
const MONTH_CORE = '(?:1[0-2]|0?[1-9])';
const LIST_JOIN = '[~\\-–·]';

// 절대 시점. 범위·나열("2019~2023년", "2023·2024년", "1~3월")도 한 낱말로 본다.
// 양끝에 단위가 붙은 범위("2019년~2023년", "1월~12월", "3분기~4분기")도 시점이다. 빠지면 예산 맞추기가 꾸밈말로 보고 먼저 지웠다.
const ABSOLUTE_TIME_PATTERN_LIST = [
  `(?:${YEAR_CORE}${LIST_JOIN})*${YEAR_CORE}년(?:도)?`,
  `${YEAR_CORE}년(?:도)?${LIST_JOIN}${YEAR_CORE}년(?:도)?`,
  `${YEAR_CORE}${LIST_JOIN}${YEAR_CORE}`,
  `'\\d{2}년?`,
  `\\d{2}년도`,
  `(?:[1-4]${LIST_JOIN})*[1-4](?:분기|사분기|Q)`,
  `[1-4]분기${LIST_JOIN}[1-4]분기`,
  'Q[1-4]', 'H[12]', `Q[1-4]${LIST_JOIN}Q[1-4]`, `H[12]${LIST_JOIN}H[12]`, `FY(?:${YEAR_CORE}|\\d{2})`,
  '(?:상|하)반기', '상·하반기', `(?:상|하)반기${LIST_JOIN}(?:상|하)반기`,
  `(?:${MONTH_CORE}${LIST_JOIN})*${MONTH_CORE}월(?:말|초|중순|초순|하순)?`,
  `${MONTH_CORE}월${LIST_JOIN}${MONTH_CORE}월`,
  '\\d{1,2}주차',
  `${YEAR_CORE}[./-]${MONTH_CORE}(?:[./-]\\d{1,2})?\\.?`,
];
// 날짜·주 수("15일", "52주")는 기간("처리 기간 15일")일 수도 있어 홀로는 되살리지 않고, 앞 시점에 이어질 때만("3월 15일") 함께 붙인다.
const DAY_WEEK_PATTERN = '\\d{1,2}(?:일|주(?:째)?)';
// 꾸밈 없는 네 자리 수("2024")는 대상 칸에서는 연도로 보지만, 근거 칸에서는 값("2000")일 수 있어 되살리지 않는다.
const BARE_YEAR_PATTERN = YEAR_CORE;
// 상대 시점. "전년 대비"처럼 비교 기준으로도 쓰여 되살리지는 않고, 대상 칸에서 빼지 않는 데만 쓴다.
const RELATIVE_TIME_PATTERN = '(?:올해|금년|작년|지난해|재작년|전년|내년|전월|지난달|당월|금월|이번달|전주|지난주|금주|이번주|전분기|당분기)';

const ABSOLUTE_TIME_WORD_PATTERN = new RegExp(`^(?:${ABSOLUTE_TIME_PATTERN_LIST.join('|')})$`, 'i');
const GROUP_TIME_WORD_PATTERN = new RegExp(`^(?:${[...ABSOLUTE_TIME_PATTERN_LIST, DAY_WEEK_PATTERN].join('|')})$`, 'i');
const TIME_WORD_PATTERN = new RegExp(
  `^(?:${[...ABSOLUTE_TIME_PATTERN_LIST, DAY_WEEK_PATTERN, BARE_YEAR_PATTERN, RELATIVE_TIME_PATTERN].join('|')})$`, 'i',
);

// 시점 낱말 뒤에 붙는 조사·꼬리. 긴 것부터 뗀다.
const TIME_SUFFIX_LIST = ['에서는', '까지', '부터', '기준', '에는', '에서', '보다', '대비', '의', '에', '은', '는', '이', '가', '을', '를',
  '과', '와', '엔', '도', '말', '초'].sort((left, right) => right.length - left.length);
// 되살려 붙일 때 떼는 끝 조사. 범위를 이루는 까지·부터와 연도의 '도'(2024년도)는 남긴다.
const INSERT_PARTICLE_LIST = ['에서는', '에는', '에서', '의', '에', '은', '는', '이', '가', '을', '를', '과', '와', '엔']
  .sort((left, right) => right.length - left.length);
const COMPARISON_BASE_PATTERN = /^(?:대비|比|보다)/;
const COMPARISON_BASE_TAIL_PATTERN = /(?:보다|대비)$/;
const RANGE_CONNECTOR_PATTERN = /^[~\-–]$/;
const MAX_SUFFIX_STRIP_COUNT = 2;

function stripTimeSuffix(word) {
  let stripped = String(word || '').replace(/[.,:;!?)\]}"'”’]+$/, '').replace(/^[(\["'“‘]+/, '');
  for (let count = 0; count < MAX_SUFFIX_STRIP_COUNT; count += 1) {
    if (TIME_WORD_PATTERN.test(stripped)) return stripped;
    const suffix = TIME_SUFFIX_LIST.find((candidate) => stripped.length > candidate.length && stripped.endsWith(candidate));
    if (!suffix) break;
    stripped = stripped.slice(0, -suffix.length);
  }
  return stripped;
}

function isTimeMarkWord(word) {
  return TIME_WORD_PATTERN.test(stripTimeSuffix(word));
}

function isAbsoluteTimeMarkWord(word) {
  return ABSOLUTE_TIME_WORD_PATTERN.test(stripTimeSuffix(word));
}

function isGroupTimeMarkWord(word) {
  return GROUP_TIME_WORD_PATTERN.test(stripTimeSuffix(word));
}

function splitMarkWordList(text) {
  return String(text || '').split(/[\s,()[\]{}]+/).filter(Boolean);
}

function hasAnyTimeMark(text) {
  return splitMarkWordList(text).some(isTimeMarkWord);
}

// 시간이 축인 자료("월별 방문자 추이")는 근거 칸의 시점 하나가 대상 전체의 시점이 아니라 축의 한 칸일 수 있다.
const TIME_AXIS_WORD_PATTERN = /(?:연도|년도|분기|반기|월|주|일|연)별|연간|월간|주간|추이|시계열/;

function hasTimeAxisWord(text) {
  return TIME_AXIS_WORD_PATTERN.test(String(text || ''));
}

function dropInsertParticle(word) {
  const particle = INSERT_PARTICLE_LIST.find((candidate) => word.length > candidate.length && word.endsWith(candidate)
    && isGroupTimeMarkWord(word.slice(0, -candidate.length)));
  return particle ? word.slice(0, -particle.length) : word;
}

// 시점을 나열한 꼴("2023, 2024년", "3, 4분기", "1,2분기", "2023·2024년")은 대상 전체의 시점인지, 값마다 다른 시점인지 알 수 없다.
// 쉼표로 나누면 앞 수("2023")는 꾸밈 없는 수로 버려지고 마지막 시점만 남아, 다른 해의 값이 그 해의 값처럼 읽혔다.
const LISTED_MARK_PATTERN = /·/;
const NUMBER_TAIL_PATTERN = /\d$/;
// 문서 작성일·출처 연도("출처 통계청 2024년", "2024년 3월 작성")는 자료가 다루는 시점이 아니다. 시점 덩어리 앞뒤 2어절 안에 이 낱말이 있으면 붙이지 않는다.
const DOCUMENT_DATE_WORD_PATTERN = /^(?:작성|발표|출처|배포|업데이트|갱신|인쇄|현재|발행|게시|제공|source|updated|published|released|printed|created)/i;
const DOCUMENT_DATE_WINDOW_WORD_COUNT = 2;

// 낱말마다 바로 앞이 "숫자·시점 + 쉼표"였는지(나열의 뒤쪽 항목인지)를 함께 적는다.
function splitMarkTokenList(text) {
  const tokenList = [];
  let isAfterListComma = false;
  for (const piece of String(text || '').replace(/,/g, ' , ').split(/[\s()[\]{}]+/).filter(Boolean)) {
    if (piece === ',') {
      const previousWord = tokenList[tokenList.length - 1]?.word || '';
      isAfterListComma = NUMBER_TAIL_PATTERN.test(previousWord) || isTimeMarkWord(previousWord);
      continue;
    }
    tokenList.push({ word: piece, isListed: isAfterListComma });
    isAfterListComma = false;
  }
  return tokenList;
}

function isDocumentDateWord(word) {
  return DOCUMENT_DATE_WORD_PATTERN.test(String(word || '').replace(/^[(\["'“‘]+/, ''));
}

function hasDocumentDateWordAround({ wordList, startIndex, endIndex }) {
  const aroundList = [
    ...wordList.slice(Math.max(0, startIndex - DOCUMENT_DATE_WINDOW_WORD_COUNT), startIndex),
    ...wordList.slice(endIndex, endIndex + DOCUMENT_DATE_WINDOW_WORD_COUNT),
  ];
  return aroundList.some(isDocumentDateWord);
}

// 근거 글에서 이어진 절대 시점 낱말을 한 덩어리로 묶는다("2024년 3분기", "2019년부터 2023년까지").
// 바로 뒤가 "대비·보다"인 덩어리는 비교 기준이고, 바로 뒤에 값이 오는 덩어리("1분기 120억")는 자료 속 항목 이름이라 뺀다.
// 서로 다른 덩어리가 꼭 하나일 때만 그 덩어리를 돌려준다. 대상 전체의 시점이라고 확신할 수 없으면 null 이다:
// 근거 글이 시간 축(월별·분기별·연도별·추이)을 말할 때(그 시점은 축의 한 칸일 수 있다), 시점을 나열했을 때, 문서 작성일·출처 연도일 때.
function readSingleTimeMark(text) {
  if (hasTimeAxisWord(text)) return null;
  const tokenList = splitMarkTokenList(text);
  const wordList = tokenList.map((token) => token.word);
  const markList = [];
  let index = 0;
  while (index < wordList.length) {
    if (!isAbsoluteTimeMarkWord(wordList[index])) { index += 1; continue; }
    const startIndex = index;
    const groupList = [wordList[index]];
    index += 1;
    while (index < wordList.length) {
      const isConnected = RANGE_CONNECTOR_PATTERN.test(wordList[index]) && isGroupTimeMarkWord(wordList[index + 1] || '');
      if (isConnected) { groupList.push(wordList[index], wordList[index + 1]); index += 2; continue; }
      if (!isGroupTimeMarkWord(wordList[index]) || tokenList[index].isListed) break;
      groupList.push(wordList[index]);
      index += 1;
    }
    const nextToken = tokenList[index];
    const isListed = tokenList[startIndex].isListed || (nextToken?.isListed && isGroupTimeMarkWord(nextToken.word))
      || groupList.some((word) => LISTED_MARK_PATTERN.test(word));
    if (isListed || hasDocumentDateWordAround({ wordList, startIndex, endIndex: index })) return null;
    const isComparisonBase = COMPARISON_BASE_PATTERN.test(wordList[index] || '')
      || COMPARISON_BASE_TAIL_PATTERN.test(groupList[groupList.length - 1]);
    const isDataLabel = /\d/.test(wordList[index] || '');
    if (!isComparisonBase && !isDataLabel) {
      groupList[groupList.length - 1] = dropInsertParticle(groupList[groupList.length - 1]);
      markList.push(groupList.join(' '));
    }
  }
  const distinctList = [...new Set(markList.map((mark) => mark.replace(/\s+/g, '')))];
  return distinctList.length === 1 ? markList[0] : null;
}

module.exports = { isTimeMarkWord, hasAnyTimeMark, hasTimeAxisWord, readSingleTimeMark };
