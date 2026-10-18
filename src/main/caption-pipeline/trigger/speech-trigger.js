// 탐지 Layer 1단계(트리거): 전사문에서 말주머니 표현을 찾아 "후보 구"를 뽑는다. 후보마다 판단 LLM이 공백인지 가린다.
// 기준은 「성능 평가 방식」 1.2 와 탐지 평가 DB 생성 지침 5장이다. 무발화(5초 이상 무음)는 렌더러의 시간 조건이라 여기 없다.
// 한국어는 Kiwi 형태소 분석 뒤 품사로 맞춘다(글자로 맞추면 주격조사 "이", 1인칭 "저"까지 걸린다).
// 후보 구는 그 표현을 담은 가장 짧은 구다("이 부분", "빨간 쪽", "42%", "결국 감소했습니다", "the red one", "really big").

const TRIGGER_TYPE_MAP = {
  demonstrative: 'demonstrative',
  adjectiveNoun: 'adjective_noun',
  number: 'number',
  change: 'change',
  scale: 'scale',
};

const TRIGGER_TYPE_LABEL_MAP = {
  [TRIGGER_TYPE_MAP.demonstrative]: '지시대명사',
  [TRIGGER_TYPE_MAP.adjectiveNoun]: '형용사 + 지시 명사',
  [TRIGGER_TYPE_MAP.number]: '단순 수치',
  [TRIGGER_TYPE_MAP.change]: '변화·비교·결론',
  [TRIGGER_TYPE_MAP.scale]: '추상적 척도',
};

const TRIGGER_LANGUAGE_MAP = { ko: 'ko', en: 'en' };
const TRIGGER_ANALYZER_MAP = { kiwi: 'kiwi', rule: 'rule', english: 'english' };

const HANGUL_PATTERN = /[가-힣]/g;
const LATIN_WORD_PATTERN = /[A-Za-z]+/g;

// 한글이 영어 낱말보다 많으면 한국어로 본다. 회의 언어 설정(auto)과 상관없이 조각마다 정한다.
function detectTriggerLanguage(text) {
  const hangulCount = (String(text).match(HANGUL_PATTERN) || []).length;
  const latinWordCount = (String(text).match(LATIN_WORD_PATTERN) || []).length;
  return hangulCount >= latinWordCount * 2 && hangulCount > 0 ? TRIGGER_LANGUAGE_MAP.ko : TRIGGER_LANGUAGE_MAP.en;
}

const TRAILING_PUNCTUATION_PATTERN = /[\s.,!?…·:;"'”’)\]]+$/;
const LEADING_PUNCTUATION_PATTERN = /^[\s"'“‘([]+/;

function buildCandidate({ text, type, start, end }) {
  const raw = text.slice(start, end);
  const leadTrim = raw.length - raw.replace(LEADING_PUNCTUATION_PATTERN, '').length;
  const phrase = raw.replace(LEADING_PUNCTUATION_PATTERN, '').replace(TRAILING_PUNCTUATION_PATTERN, '');
  if (!phrase) return null;
  return { type, phrase, start: start + leadTrim, end: start + leadTrim + phrase.length };
}

function isInside({ inner, outer }) {
  return inner !== outer && inner.start >= outer.start && inner.end <= outer.end;
}

// 같은 자리를 두 번 넘기지 않는다. 지시 구 안의 형용사+명사·수치("이 빨간 쪽", "these two shots")는 지시 하나로 본다.
function dedupeCandidateList(candidateList) {
  const sortedList = [...candidateList].sort((left, right) => (left.start - right.start) || (right.end - left.end));
  const keptList = [];
  for (const candidate of sortedList) {
    const isDuplicate = keptList.some((kept) => kept.start === candidate.start && kept.end === candidate.end);
    const isAbsorbed = keptList.some((kept) => kept.type === TRIGGER_TYPE_MAP.demonstrative
      && candidate.type !== TRIGGER_TYPE_MAP.demonstrative && isInside({ inner: candidate, outer: kept }));
    const isSameTypeInside = keptList.some((kept) => kept.type === candidate.type && isInside({ inner: candidate, outer: kept }));
    if (!isDuplicate && !isAbsorbed && !isSameTypeInside) keptList.push(candidate);
  }
  return keptList.sort((left, right) => left.start - right.start);
}

// ── 한국어 (Kiwi 품사) ──

const NOUN_TAG_SET = new Set(['NNG', 'NNP', 'NNB', 'NR']);
const PREDICATE_ADJ_TAG_SET = new Set(['VA', 'VA-I', 'VA-R']);
const PREDICATE_VERB_TAG_SET = new Set(['VV', 'VV-I', 'VV-R']);
const DEMONSTRATIVE_DETERMINER_SET = new Set(['이', '그', '저', '요']);
const DEMONSTRATIVE_PRONOUN_SET = new Set([
  '이거', '그거', '저거', '요거', '이것', '그것', '저것', '요것',
  '여기', '거기', '저기', '요기', '이곳', '그곳', '저곳', '이쪽', '그쪽', '저쪽', '요쪽', '이분', '그분', '저분',
]);
const DEMONSTRATIVE_ADVERB_SET = new Set(['이렇게', '그렇게', '저렇게', '요렇게']);
const DEMONSTRATIVE_ADJ_STEM_SET = new Set(['이렇', '그렇', '저렇', '요렇']);
// "그 때", "그 정도"처럼 화면의 대상이 아니라 시간·정도를 가리키는 말.
const NON_REFERENT_NOUN_SET = new Set([
  '때', '정도', '동안', '후', '전', '이후', '이전', '사이', '순간', '덕분', '탓', '만큼', '뿐', '대신', '와중', '무렵', '즈음',
  '다음', '외', '밖', '중', '뒤', '앞', '날', '당시', '그때',
]);
const REFERENT_BOUND_NOUN_SET = new Set(['쪽', '부분', '거', '것', '곳']);
// 존재·같음·지시 형용사는 대상을 가려 주는 형용사가 아니다("있는 거", "같은 것", "그런 거").
const NON_DESCRIPTIVE_ADJ_SET = new Set(['있', '없', '같', '이렇', '그렇', '저렇', '요렇', '어떻', '아무렇', '다르']);
// Kiwi 가 문맥에 따라 동사로 분석하는 형용사("싼 쪽"의 싸다).
const ADJ_ANALYZED_AS_VERB_SET = new Set(['싸']);
const NUMERAL_DETERMINER_SET = new Set([
  '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '스무', '수십', '수백', '수천', '몇',
]);
// 날짜·시각·순번은 "무엇의 수치인지"를 묻는 값이 아니다.
const NON_QUANTITY_UNIT_SET = new Set([
  '년', '년대', '월', '시', '번', '호', '차', '학년', '기', '회차', '번째', '째', '세기', '분기', '호점', '조',
]);
const UNIT_NOUN_SET = new Set([
  '퍼센트', '프로', '퍼센트포인트', '포인트', '달러', '유로', '엔', '위안', '킬로', '킬로미터', '미터', '센티', '센티미터', '밀리',
  '그램', '킬로그램', '톤', '리터', '시간', '개월', '주', '배',
]);
const UNIT_SYMBOL_SET = new Set(['%', '℃', '°', '$', '₩']);
const CHANGE_VERB_SET = new Set([
  '오르', '올라가', '올라오', '떨어지', '내리', '내려가', '늘', '늘어나', '늘리', '줄', '줄어들', '줄이', '뛰', '뛰어오르',
  '바뀌', '달라지', '앞서', '앞지르', '뒤지', '넘', '넘어서', '추월하', '불어나', '꺾이', '치솟', '곤두박질치', '반토막나',
]);
const CHANGE_NOUN_SET = new Set([
  '증가', '감소', '상승', '하락', '단축', '개선', '악화', '향상', '저하', '성장', '급증', '급감', '확대', '축소', '증대', '감축',
  '둔화', '반등', '회복', '역전', '추월', '폭증', '폭락', '급등', '급락', '반감', '배증', '인상', '인하', '절감', '감량',
]);
const COMPARISON_MARKER_FORM_SET = new Set(['보다', '더', '덜']);
// 사람이 늘리고 줄이는 타동사. 지난 일(었·았)이 아니면 "줄이겠습니다", "늘립니다", "내려 보세요"처럼 계획·지시라 값의 변화가 아니다.
const AGENTIVE_CHANGE_VERB_SET = new Set(['늘리', '줄이', '내리']);
const PAST_TENSE_FORM_SET = new Set(['었', '았', '였', '었었', '았었']);
// "-겠-", "-ㄹ게요"는 말하는 사람의 의지라 이미 일어난 변화가 아니다.
const INTENTION_ENDING_PATTERN = /^(?:ᆯ|을)게/;
// "한 번 더", "하나 더"의 더는 비교가 아니라 덧붙임이다.
const ADDITIVE_COUNT_FORM_SET = new Set(['번', '개', '명', '대', '곳', '하나', '둘', '셋']);
const CONCLUSION_MARKER_SET = new Set(['결국', '따라서', '결과적으로', '결론적으로', '최종적으로']);
const SCALE_ADJ_SET = new Set(['크', '작', '길', '짧', '넓', '좁', '많', '적']);

// ── 탐지 평가 DB 어휘 목록 밖 표현 ──
// 화면 속 대상의 정도를 말하는 척도 형용사(DB 목록 밖).
const MEASURABLE_ADJ_SET = new Set([
  '높', '낮', '빠르', '느리', '무겁', '가볍', '두껍', '얇', '깊', '얕', '굵', '가늘', '밝', '어둡', '멀', '가깝',
  '비싸', '드물', '흔하', '심하', '촘촘하', '빽빽하', '넉넉하',
]);
// 어근 + 하다로 나뉘어 분석되는 척도 형용사("넉넉/XR 하/XSA").
const SCALE_ROOT_SET = new Set(['넉넉', '촘촘', '빽빽', '흔', '심']);
// 양·정도를 말하는 부사. "오래"처럼 시간만 말하는 부사는 화면으로 볼 수 없어 넣지 않는다.
const QUANTITY_ADVERB_SET = new Set([
  '많이', '대거', '잔뜩', '쑥쑥', '멀리', '가득', '수북이', '듬뿍', '온통', '왕창', '빼곡히', '촘촘히', '넉넉히',
]);
// 수 없는 비율·양 말. 조사가 붙거나("대부분이") 비율 꼬리말("절반 이상")이 이어질 때만 본다.
const PROPORTION_NOUN_SET = new Set(['대부분', '대다수', '상당수', '상당량', '절반', '과반', '과반수', '태반', '소수', '극소수', '다수', '일부']);
const PROPORTION_ADVERB_SET = new Set(['대개', '대체로', '대부분']);
const PROPORTION_TAIL_SET = new Set(['이상', '이하', '가까이', '정도', '넘게', '남짓']);
const NEARLY_ALL_FORM_SET = new Set(['다', '모두', '전부']);
// 남의 말을 옮기는 연결 어미("꽤 높다고들 하죠").
const QUOTATIVE_ENDING_SET = new Set(['다고', '라고', '냐고', '자고']);
// 최상·극값 명사. 접두사가 갈라져 나오면(최/XPN 하위/NNG) 붙여서 본다.
const SUPERLATIVE_NOUN_SET = new Set([
  '최고', '최저', '최대', '최소', '최다', '최악', '최상', '최고치', '최저치', '최대치', '최소치', '최댓값', '최솟값',
  '최상위', '최하위', '최상위권', '최하위권', '최고점', '최저점', '정점', '저점', '고점', '꼴찌', '으뜸', '신기록',
]);
const SUPERLATIVE_PREFIX_WORD_SET = new Set(['역대', '사상', '역사상', '연중', '업계', '국내', '세계', '전국']);
const SUPERLATIVE_ADVERB_SET = new Set(['가장', '제일']);
// 비교 표지 없이 비교하는 동사·형용사, 그리고 하다·이다가 붙는 비교 명사.
const COMPARISON_VERB_SET = new Set(['밑돌', '웃돌', '맞먹', '뒤처지', '따라잡', '버금가', '못지않', '비슷하', '엇비슷하']);
const COMPARISON_NOUN_SET = new Set([
  '능가', '육박', '상회', '하회', '필적', '압도', '동률', '동점', '비등', '대등', '우세', '열세', '박빙', '백중세', '비슷', '엇비슷',
]);
// 추세·멈춤 명사. "흐름"은 말의 흐름("흐름이 끊겼네요")으로도 써서 넣지 않는다.
const TREND_NOUN_SET = new Set(['오름세', '내림세', '상승세', '하락세', '증가세', '감소세', '회복세', '둔화세', '강세', '약세', '반등세', '보합세']);
const STAGNATION_NOUN_SET = new Set(['주춤', '정체', '횡보', '답보', '제자리걸음']);
const DIFFERENCE_PREDICATE_SET = new Set(['없', '나', '크', '작', '줄', '좁', '벌어지', '좁혀지', '줄어들']);
// 정해진 술어와 함께 쓸 때만 변화로 보는 명사: 바닥을 찍다, 기록을 갈아치우다, 차이가 없다, 흑자로 돌아서다, 동률을 이루다.
const ANCHOR_PREDICATE_MAP = new Map([
  ['바닥', new Set(['찍'])],
  ['기록', new Set(['갈', '경신', '갱신', '깨'])],
  ['차이', DIFFERENCE_PREDICATE_SET],
  ['격차', DIFFERENCE_PREDICATE_SET],
  ['흑자', new Set(['돌아서'])],
  ['적자', new Set(['돌아서'])],
]);
const COMPARISON_NOUN_PREDICATE_SET = new Set(['이루', '보이', '기록']);
// 목적·의도를 나타내는 연결 어미("차이가 없도록 준비했습니다").
const PURPOSE_ENDING_SET = new Set(['도록', '려고', '으려고', '고자']);

function buildWordIndexList(text) {
  const wordIndexList = new Array(text.length).fill(-1);
  let wordIndex = -1;
  let isInWord = false;
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index])) { isInWord = false; continue; }
    if (!isInWord) { wordIndex += 1; isInWord = true; }
    wordIndexList[index] = wordIndex;
  }
  return wordIndexList;
}

function createKoreanContext({ text, tokenList }) {
  const wordIndexList = buildWordIndexList(text);
  const wordOf = (token) => wordIndexList[Math.min(Math.max(token.start, 0), text.length - 1)];
  const wordSpanList = [];
  text.replace(/\S+/g, (word, offset) => { wordSpanList.push({ start: offset, end: offset + word.length }); return word; });
  return { text, tokenList, wordOf, wordSpanList };
}

function wordEndOf({ context, token }) {
  return context.wordSpanList[context.wordOf(token)]?.end ?? token.end;
}

function wordStartOf({ context, token }) {
  return context.wordSpanList[context.wordOf(token)]?.start ?? token.start;
}

function isSentenceBoundary(token) {
  return token.tag === 'SF';
}

// 술어 어절 앞에 붙은 부사어 어절(꽤·훨씬·결국·눈에 띄게의 "띄게")을 거슬러 올라가 후보 구의 시작으로 삼는다.
function isAdverbialWord({ context, wordIndex }) {
  const wordTokenList = context.tokenList.filter((token) => context.wordOf(token) === wordIndex);
  if (!wordTokenList.length) return false;
  const last = wordTokenList[wordTokenList.length - 1];
  if (last.tag === 'MAG' || last.tag === 'MAJ') return true;
  return last.tag === 'EC' && last.form === '게';
}

function extendStartOverAdverbial({ context, startWordIndex }) {
  let wordIndex = startWordIndex;
  while (wordIndex > 0 && isAdverbialWord({ context, wordIndex: wordIndex - 1 })) wordIndex -= 1;
  return context.wordSpanList[wordIndex].start;
}

function findNextIndex({ tokenList, fromIndex, isMatch, maxDistance }) {
  for (let index = fromIndex + 1; index < tokenList.length && index <= fromIndex + maxDistance; index += 1) {
    if (isSentenceBoundary(tokenList[index])) return -1;
    if (isMatch(tokenList[index])) return index;
  }
  return -1;
}

function detectKoreanDemonstrative(context) {
  const { tokenList, text } = context;
  const candidateList = [];
  tokenList.forEach((token, index) => {
    if (token.tag === 'MM' && DEMONSTRATIVE_DETERMINER_SET.has(token.form)) {
      // "반이 자막을"처럼 앞말에 붙은 "이"를 Kiwi 가 관형사로 자르는 일이 있다. 지시 관형사는 띄어 쓴다.
      const previous = tokenList[index - 1];
      if (previous && previous.end === token.start && !/^S/.test(previous.tag)) return;
      const nounIndex = findNextIndex({
        tokenList, fromIndex: index, maxDistance: 4,
        isMatch: (next) => NOUN_TAG_SET.has(next.tag),
      });
      if (nounIndex < 0 || NON_REFERENT_NOUN_SET.has(tokenList[nounIndex].form)) return;
      let endIndex = nounIndex;
      while (endIndex + 1 < tokenList.length && NOUN_TAG_SET.has(tokenList[endIndex + 1].tag)
        && context.wordOf(tokenList[endIndex + 1]) === context.wordOf(tokenList[nounIndex])) endIndex += 1;
      candidateList.push(buildCandidate({
        text, type: TRIGGER_TYPE_MAP.demonstrative, start: token.start, end: tokenList[endIndex].end,
      }));
      return;
    }
    if (token.tag === 'NP' && DEMONSTRATIVE_PRONOUN_SET.has(token.form)) {
      candidateList.push(buildCandidate({ text, type: TRIGGER_TYPE_MAP.demonstrative, start: token.start, end: token.end }));
      return;
    }
    if (token.tag === 'MAG' && DEMONSTRATIVE_ADVERB_SET.has(token.form)) {
      candidateList.push(buildCandidate({ text, type: TRIGGER_TYPE_MAP.demonstrative, start: token.start, end: token.end }));
      return;
    }
    const next = tokenList[index + 1];
    if (PREDICATE_ADJ_TAG_SET.has(token.tag) && DEMONSTRATIVE_ADJ_STEM_SET.has(token.form)
      && next?.tag === 'EC' && next.form === '게') {
      candidateList.push(buildCandidate({
        text, type: TRIGGER_TYPE_MAP.demonstrative, start: token.start, end: wordEndOf({ context, token: next }),
      }));
    }
  });
  return candidateList.filter(Boolean);
}

// 형용사 관형형 + 쪽·부분·거·것·곳. "깨끗한 쪽"처럼 어근+하다 형용사도 넣는다. 동사 관형절("표시한 거")은 범위 밖이다.
function detectKoreanAdjectiveNoun(context) {
  const { tokenList, text } = context;
  const candidateList = [];
  tokenList.forEach((token, index) => {
    const etm = tokenList[index + 1];
    const noun = tokenList[index + 2];
    if (etm?.tag !== 'ETM' || !noun || !REFERENT_BOUND_NOUN_SET.has(noun.form) || !NOUN_TAG_SET.has(noun.tag)) return;
    let startToken = null;
    if (PREDICATE_ADJ_TAG_SET.has(token.tag) && !NON_DESCRIPTIVE_ADJ_SET.has(token.form)) startToken = token;
    if (token.tag === 'VV' && ADJ_ANALYZED_AS_VERB_SET.has(token.form)) startToken = token;
    // "뾰족한 거"처럼 Kiwi 가 어근을 부사(MAG)로 분석하는 형용사도 넣는다.
    if (token.tag === 'XSA' && index > 0 && ['XR', 'NNG', 'MAG'].includes(tokenList[index - 1].tag)) startToken = tokenList[index - 1];
    // "오래된 것": 부사 + 되다는 상태를 나타내 형용사처럼 대상을 가린다.
    if (token.tag === 'XSV' && token.form === '되' && tokenList[index - 1]?.tag === 'MAG') startToken = tokenList[index - 1];
    if (!startToken) return;
    candidateList.push(buildCandidate({ text, type: TRIGGER_TYPE_MAP.adjectiveNoun, start: startToken.start, end: noun.end }));
  });
  return candidateList.filter(Boolean);
}

function isAdjectiveToken(token) {
  if (!token) return false;
  return PREDICATE_ADJ_TAG_SET.has(token.tag) || (token.tag === 'VV' && ADJ_ANALYZED_AS_VERB_SET.has(token.form));
}

function isNumberToken(token) {
  return token.tag === 'SN' || (token.tag === 'NR' && /^[일이삼사오육칠팔구십백천만억조]+$/.test(token.form));
}

// 숫자에 붙여 쓴 일반명사("214가구", "52곳")도 단위로 본다. 띄어 쓴 일반명사는 단위 목록에 있을 때만.
function isUnitToken(token, { isAttached = false } = {}) {
  if (!token) return false;
  if (NON_QUANTITY_UNIT_SET.has(token.form)) return false;
  if (token.tag === 'NNB') return true;
  if (token.tag === 'NNG' && isAttached) return true;
  if (token.tag === 'SW' || token.tag === 'SO') return UNIT_SYMBOL_SET.has(token.form);
  if (token.tag === 'SL') return /^[a-zA-Z]{1,4}$/.test(token.form);
  return token.tag === 'NNG' && UNIT_NOUN_SET.has(token.form);
}

// 숫자(+만·억 같은 수사) + 단위. "4억 5천만 원"처럼 띄어 쓴 큰 수도 한 구로 묶는다. 단위 없는 맨 숫자는 범위 밖이다.
function detectKoreanNumber(context) {
  const { tokenList, text } = context;
  const candidateList = [];
  let index = 0;
  while (index < tokenList.length) {
    const token = tokenList[index];
    const isNumeralDeterminer = token.tag === 'MM' && NUMERAL_DETERMINER_SET.has(token.form);
    if (!isNumberToken(token) && !isNumeralDeterminer) { index += 1; continue; }
    let endIndex = index;
    while (endIndex + 1 < tokenList.length && isNumberToken(tokenList[endIndex + 1])) endIndex += 1;
    const unit = tokenList[endIndex + 1];
    // 붙여 쓴 일반명사 뒤에 명사가 또 오면 "4조 빵", "3분기 매출"처럼 이름표라 수치가 아니다.
    const isAttached = Boolean(unit) && unit.start === tokenList[endIndex].end
      && !(unit.tag === 'NNG' && ['NNG', 'NNP'].includes(tokenList[endIndex + 2]?.tag))
      && !(unit.tag === 'NNG' && tokenList[endIndex + 2]?.tag === 'NNB' && tokenList[endIndex + 2].start === unit.end);
    // "두 대", "한 달"처럼 고유어 수 관형사로 센 개수·기간은 발화로 이미 정해진 값이라 화면 수치가 아니다.
    // "1kg에 4,000원"의 1kg처럼 다른 수치의 기준이 되는 단위, "한 건도 없다"처럼 없음을 말하는 수도 넘긴다.
    if (isUnitToken(unit, { isAttached }) && !isNumeralDeterminer) {
      if (!isBasisOrNoneQuantity({ tokenList, unitIndex: endIndex + 1 })) {
        candidateList.push(buildCandidate({ text, type: TRIGGER_TYPE_MAP.number, start: token.start, end: unit.end }));
      }
      index = endIndex + 2;
    } else {
      index = endIndex + 1;
    }
  }
  return candidateList.filter(Boolean);
}

function isBasisOrNoneQuantity({ tokenList, unitIndex }) {
  const next = tokenList[unitIndex + 1];
  if (next?.tag === 'JKB' && ['에', '당'].includes(next.form) && isNumberToken(tokenList[unitIndex + 2] || {})) return true;
  return next?.tag === 'JX' && next.form === '도' && ['없', '않'].includes(tokenList[unitIndex + 2]?.form);
}

function isComparisonMarker(token) {
  if (COMPARISON_MARKER_FORM_SET.has(token.form) && ['JKB', 'MAG'].includes(token.tag)) return true;
  return (token.form === '비하' && token.tag === 'VV') || (token.form === '대비' && token.tag === 'NNG');
}

function isAdditiveMore({ tokenList, index }) {
  const token = tokenList[index];
  return token.form === '더' && ADDITIVE_COUNT_FORM_SET.has(tokenList[index - 1]?.form);
}

function isComparisonMarkerAt({ tokenList, index }) {
  return isComparisonMarker(tokenList[index]) && !isAdditiveMore({ tokenList, index });
}

function hasComparisonMarkerBefore({ context, index, maxDistance = 6 }) {
  const { tokenList } = context;
  for (let back = index - 1; back >= 0 && back >= index - maxDistance; back -= 1) {
    const token = tokenList[back];
    if (token.tag === 'EC' && tokenList[back - 1]?.form === '비하') return true;
    if (isSentenceBoundary(token) || (token.tag === 'EC' && token.form !== '게')) return false;
    if (isAdditiveMore({ tokenList, index: back })) return false;
    if (isComparisonMarker(token)) return true;
  }
  return false;
}

// 술어 줄기: 동사·형용사, 또는 어근/명사 + 하다·되다. 관형형(ETM)으로 명사를 꾸미면 술어가 아니다.
function readPredicateStemIndex({ tokenList, index }) {
  const token = tokenList[index];
  const next = tokenList[index + 1];
  if (next?.tag === 'ETM') return -1;
  if (PREDICATE_VERB_TAG_SET.has(token.tag) || PREDICATE_ADJ_TAG_SET.has(token.tag)) return index;
  if (['XSV', 'XSA'].includes(token.tag) && index > 0 && ['NNG', 'XR', 'MAG'].includes(tokenList[index - 1].tag)) return index - 1;
  return -1;
}

const ADJ_TO_CHANGE_VERB_PATTERN = /(?:아|어|여|해|워|와|러)지$/;
// Kiwi 가 줄어든 꼴(크+어지 → 커지)을 동사 한 덩어리로 자르는 형용사+어지다.
const CONTRACTED_ADJ_CHANGE_VERB_SET = new Set(['커지', '나빠지', '흐려지']);

// 변화 술어의 줄기(stem) 토큰 위치. 없으면 -1.
function findChangeStemIndex({ context, index }) {
  const { tokenList } = context;
  const token = tokenList[index];
  if (PREDICATE_VERB_TAG_SET.has(token.tag) && CHANGE_VERB_SET.has(token.form)) {
    // "줄인 집단", "무너져 내린 흙더미"처럼 관형형으로 명사를 꾸미면 술어가 아니다.
    return tokenList[index + 1]?.tag === 'ETM' ? -1 : index;
  }
  // "길어지다", "좋아지다"처럼 한 동사로 분석된 형용사+어지다.
  if (PREDICATE_VERB_TAG_SET.has(token.tag)
    && (ADJ_TO_CHANGE_VERB_PATTERN.test(token.form) || CONTRACTED_ADJ_CHANGE_VERB_SET.has(token.form))
    && tokenList[index + 1]?.tag !== 'ETM') return index;
  if (token.tag === 'VV' && token.form === '미치' && tokenList[index - 1]?.form === '못') return index;
  // 비교 표지 없이 비교하는 술어("밑돌았어요", "거의 비슷합니다").
  if ((PREDICATE_VERB_TAG_SET.has(token.tag) || PREDICATE_ADJ_TAG_SET.has(token.tag)) && COMPARISON_VERB_SET.has(token.form)) {
    return tokenList[index + 1]?.tag === 'ETM' ? -1 : index;
  }
  // 비교·멈춤 명사 + 하다·되다·이다("우세합니다", "능가했어요", "주춤했어요", "박빙이에요", "제자리걸음이에요").
  if (['XSV', 'XSA', 'VCP'].includes(token.tag) && index > 0 && tokenList[index + 1]?.tag !== 'ETM'
    && ['NNG', 'XR', 'MAG'].includes(tokenList[index - 1].tag)
    && (COMPARISON_NOUN_SET.has(tokenList[index - 1].form) || STAGNATION_NOUN_SET.has(tokenList[index - 1].form))) return index - 1;
  // 가장·제일 + 술어("가장 붐볐습니다").
  const superlativeStemIndex = readPredicateStemIndex({ tokenList, index });
  if (superlativeStemIndex >= 0 && SUPERLATIVE_ADVERB_SET.has(tokenList[superlativeStemIndex - 1]?.form)
    && tokenList[superlativeStemIndex - 1].tag === 'MAG') return superlativeStemIndex;
  if (token.tag === 'XSV' && index > 0 && CHANGE_NOUN_SET.has(tokenList[index - 1].form)) return index - 1;
  // 형용사 + 어 + 지다: "좋아졌다", "높아졌다".
  if (token.tag === 'VX' && token.form === '지' && tokenList[index - 1]?.tag === 'EC'
    && isAdjectiveToken(tokenList[index - 2])) return index - 2;
  // 비교: 비교 표지(보다·더·덜·에 비해·대비) 뒤 첫 술어. "보다 많았어요", "더 잘 버텼어요", "보다 단연 우세했어요".
  const stemIndex = readPredicateStemIndex({ tokenList, index });
  if (stemIndex < 0 || isComparisonMarker(token) || NON_DESCRIPTIVE_ADJ_SET.has(tokenList[stemIndex].form)) return -1;
  if (!hasComparisonMarkerBefore({ context, index: stemIndex })) return -1;
  return isFirstPredicateAfterMarker({ context, stemIndex }) ? stemIndex : -1;
}

// 비교 표지와 이 술어 사이에 다른 술어가 있으면 그 술어가 비교의 술어다.
function isFirstPredicateAfterMarker({ context, stemIndex }) {
  const { tokenList } = context;
  for (let back = stemIndex - 1; back >= 0; back -= 1) {
    const token = tokenList[back];
    if (isComparisonMarkerAt({ tokenList, index: back })) return true;
    if (isSentenceBoundary(token)) return false;
    if (readPredicateStemIndex({ tokenList, index: back }) >= 0 && token.tag !== 'MAG') return false;
  }
  return false;
}

function detectKoreanChange(context) {
  const { tokenList, text } = context;
  const candidateList = [];
  const usedWordSet = new Set();
  tokenList.forEach((token, index) => {
    const stemIndex = findChangeStemIndex({ context, index });
    if (stemIndex < 0) return;
    const stem = tokenList[stemIndex];
    if (isPlannedChange({ tokenList, stemIndex })) return;
    let endToken = token;
    // "더 낮게 나왔습니다"처럼 비교 형용사가 부사어(-게)면 뒤 술어 어절까지 한 구로 잡는다.
    const next = tokenList[index + 1];
    if (next?.tag === 'EC' && next.form === '게') {
      const verbIndex = findNextIndex({ tokenList, fromIndex: index + 1, maxDistance: 3, isMatch: (later) => PREDICATE_VERB_TAG_SET.has(later.tag) });
      if (verbIndex >= 0) endToken = tokenList[verbIndex];
    }
    const predicateWordIndex = context.wordOf(endToken);
    if (usedWordSet.has(predicateWordIndex)) return;
    usedWordSet.add(predicateWordIndex);
    const start = extendStartOverAdverbial({ context, startWordIndex: context.wordOf(stem) });
    candidateList.push(buildCandidate({
      text, type: TRIGGER_TYPE_MAP.change, start, end: wordEndOf({ context, token: endToken }),
    }));
  });
  // 결론 표지("결국", "따라서")가 바로 앞에 없더라도 같은 문장의 변화 구와 이어지면 표지부터 한 구로 묶는다.
  return candidateList.filter(Boolean).map((candidate) => attachConclusionMarker({ context, candidate }));
}

// 술어 줄기 뒤 어미를 문장 끝(EF)까지 본다. 의지 어미면 계획이고, 사람이 하는 타동사(늘리·줄이·내리)가 지난 일이 아니면 지시·계획이다.
function isPlannedChange({ tokenList, stemIndex }) {
  const endingList = [];
  for (let cursor = stemIndex + 1; cursor < tokenList.length && cursor <= stemIndex + 6; cursor += 1) {
    const token = tokenList[cursor];
    if (isSentenceBoundary(token)) break;
    endingList.push(token);
    if (token.tag === 'EF') break;
  }
  if (endingList.some((token) => (token.tag === 'EP' && token.form === '겠') || (token.tag === 'EF' && INTENTION_ENDING_PATTERN.test(token.form)))) {
    return true;
  }
  const stem = tokenList[stemIndex];
  if (!AGENTIVE_CHANGE_VERB_SET.has(stem.form)) return false;
  return !endingList.some((token) => token.tag === 'EP' && PAST_TENSE_FORM_SET.has(token.form));
}

function attachConclusionMarker({ context, candidate }) {
  const { tokenList, text } = context;
  const firstIndex = tokenList.findIndex((token) => token.start >= candidate.start);
  for (let back = firstIndex - 1; back >= 0 && back >= firstIndex - 4; back -= 1) {
    const token = tokenList[back];
    if (isSentenceBoundary(token)) break;
    if (CONCLUSION_MARKER_SET.has(token.form)) {
      return buildCandidate({ text, type: candidate.type, start: wordStartOf({ context, token }), end: candidate.end }) || candidate;
    }
  }
  return candidate;
}

// 추상적 척도: 크다·작다·길다·짧다·넓다·좁다·많다·적다가 술어로 쓰인 것. 비교("보다 많다")는 변화·비교로 넘긴다.
// 척도 형용사의 줄기 위치. DB 목록(크다·많다 등)은 isListed 로 알린다. 아니면 -1.
function readScaleStem({ tokenList, index }) {
  const token = tokenList[index];
  if (PREDICATE_ADJ_TAG_SET.has(token.tag) && SCALE_ADJ_SET.has(token.form)) return { stemIndex: index, isListed: true };
  if (PREDICATE_ADJ_TAG_SET.has(token.tag) && MEASURABLE_ADJ_SET.has(token.form)) return { stemIndex: index, isListed: false };
  const previous = tokenList[index - 1];
  if (token.tag === 'XSA' && previous && ['XR', 'MAG', 'NNG'].includes(previous.tag) && SCALE_ROOT_SET.has(previous.form)) {
    return { stemIndex: index - 1, isListed: false };
  }
  return null;
}

// 추상적 척도: 척도 형용사가 술어로 쓰인 것("꽤 넓죠", "아주 빠릅니다", "깊은 편입니다"). 비교("보다 많다")는 변화·비교로 넘긴다.
function detectKoreanScale(context) {
  const { tokenList, text } = context;
  const candidateList = [];
  tokenList.forEach((token, index) => {
    const scaleStem = readScaleStem({ tokenList, index });
    if (!scaleStem) return;
    const next = tokenList[index + 1];
    let endToken = token;
    if (next?.tag === 'ETM' && tokenList[index + 2]?.form === '편' && tokenList[index + 2].tag === 'NNB') {
      endToken = tokenList[index + 3]?.tag === 'VCP' ? tokenList[index + 3] : tokenList[index + 2];
    } else {
      if (!next || next.tag === 'ETM' || (next.tag === 'EC' && next.form === '게')) return;
      if (next.tag === 'EC' && tokenList[index + 2]?.tag === 'VX' && tokenList[index + 2].form === '지') return;
      if (!['EF', 'EC', 'EP'].includes(next.tag)) return;
      if (!scaleStem.isListed && next.tag === 'EC' && QUOTATIVE_ENDING_SET.has(next.form)) return;
    }
    if (hasComparisonMarkerBefore({ context, index: scaleStem.stemIndex })) return;
    const start = extendStartOverAdverbial({ context, startWordIndex: context.wordOf(tokenList[scaleStem.stemIndex]) });
    candidateList.push(buildCandidate({ text, type: TRIGGER_TYPE_MAP.scale, start, end: wordEndOf({ context, token: endToken }) }));
  });
  return candidateList.filter(Boolean);
}

// 술어 어미가 관형형(ETM)으로 끝나 명사를 꾸미는지("크게 걱정하실 필요").
function endsInModifier({ tokenList, index }) {
  for (let cursor = index + 1; cursor < tokenList.length && cursor <= index + 4; cursor += 1) {
    const token = tokenList[cursor];
    if (token.tag === 'ETM') return true;
    if (token.tag !== 'EP') return false;
  }
  return false;
}

// 부사어 뒤 같은 문장 안의 첫 술어(줄기 위치와 그 술어 토큰).
function findPredicateAfterAdverb({ tokenList, fromIndex, maxDistance = 4 }) {
  for (let cursor = fromIndex + 1; cursor < tokenList.length && cursor <= fromIndex + maxDistance; cursor += 1) {
    if (isSentenceBoundary(tokenList[cursor])) return null;
    const stemIndex = readPredicateStemIndex({ tokenList, index: cursor });
    if (stemIndex >= 0 && tokenList[stemIndex].tag !== 'MAG') return { stemIndex, predicateIndex: cursor };
  }
  return null;
}

// 척도 부사 + 동사: "꽤 많이 설치했습니다", "두껍게 쌓였습니다", "대거 모였습니다". 값의 변화 술어("많이 올랐습니다")는 변화로 넘긴다.
function detectKoreanScaleAdverb(context) {
  const { tokenList, text } = context;
  const candidateList = [];
  tokenList.forEach((token, index) => {
    let adverbStartIndex = -1;
    let adverbEndIndex = -1;
    const scaleStem = readScaleStem({ tokenList, index });
    if (scaleStem && tokenList[index + 1]?.tag === 'EC' && tokenList[index + 1].form === '게') {
      adverbStartIndex = scaleStem.stemIndex;
      adverbEndIndex = index + 1;
    } else if (token.tag === 'MAG' && QUANTITY_ADVERB_SET.has(token.form)) {
      adverbStartIndex = index;
      adverbEndIndex = index;
    } else {
      return;
    }
    const predicate = findPredicateAfterAdverb({ tokenList, fromIndex: adverbEndIndex });
    if (!predicate) return;
    if (endsInModifier({ tokenList, index: predicate.predicateIndex })) return;
    if (isPlannedChange({ tokenList, stemIndex: predicate.stemIndex })) return;
    if (findChangeStemIndex({ context, index: predicate.predicateIndex }) >= 0) return;
    if (hasComparisonMarkerBefore({ context, index: adverbStartIndex })) return;
    const start = extendStartOverAdverbial({ context, startWordIndex: context.wordOf(tokenList[adverbStartIndex]) });
    candidateList.push(buildCandidate({
      text, type: TRIGGER_TYPE_MAP.scale, start, end: wordEndOf({ context, token: tokenList[predicate.predicateIndex] }),
    }));
  });
  return candidateList.filter(Boolean);
}

function isFirstTokenOfWord({ context, index }) {
  return index === 0 || context.wordOf(context.tokenList[index - 1]) !== context.wordOf(context.tokenList[index]);
}

function readWordText({ context, token }) {
  const span = context.wordSpanList[context.wordOf(token)];
  return span ? context.text.slice(span.start, span.end) : '';
}

// 같은 문장 안에서 이 위치 뒤 첫 술어 줄기. 없으면 -1.
function findSentencePredicateStemIndex({ tokenList, fromIndex }) {
  for (let cursor = fromIndex + 1; cursor < tokenList.length; cursor += 1) {
    if (isSentenceBoundary(tokenList[cursor])) return -1;
    if (tokenList[cursor].tag === 'VCP') return cursor;
    const stemIndex = readPredicateStemIndex({ tokenList, index: cursor });
    if (stemIndex >= 0 && tokenList[stemIndex].tag !== 'MAG') return stemIndex;
  }
  return -1;
}

// 수 없는 비율·양 말: "대부분이", "절반 이상이", "상당 부분이", "거의 다", "몇몇 조만", "대개". 뒤 술어가 계획·의지면 뺀다.
function detectKoreanProportion(context) {
  const { tokenList, text } = context;
  const candidateList = [];
  tokenList.forEach((token, index) => {
    const next = tokenList[index + 1];
    let endIndex = -1;
    if (token.tag === 'NNG' && PROPORTION_NOUN_SET.has(token.form)) {
      if (next && PROPORTION_TAIL_SET.has(next.form)) endIndex = index + 1;
      else if (next && /^J/.test(next.tag)) endIndex = index;
    } else if (token.tag === 'NNG' && token.form === '상당' && next?.form === '부분' && /^J/.test(tokenList[index + 2]?.tag || '')) {
      endIndex = index + 1;
    } else if (token.tag === 'MAG' && PROPORTION_ADVERB_SET.has(token.form)) {
      endIndex = index;
    } else if (token.tag === 'MAG' && token.form === '거의' && next?.tag === 'MAG' && NEARLY_ALL_FORM_SET.has(next.form)) {
      endIndex = index + 1;
    } else if (isFirstTokenOfWord({ context, index }) && readWordText({ context, token }) === '몇몇') {
      // Kiwi 는 문장 첫머리의 "몇몇"을 몇/NR 몇/NR 로 자르기도 해서 어절 글자로 본다. 뒤 어절(세는 말)까지 한 구로.
      endIndex = tokenList.findIndex((later, laterIndex) => laterIndex > index && context.wordOf(later) === context.wordOf(token) + 1);
    }
    if (endIndex < 0) return;
    const stemIndex = findSentencePredicateStemIndex({ tokenList, fromIndex: endIndex });
    if (stemIndex < 0 || isPlannedChange({ tokenList, stemIndex })) return;
    candidateList.push(buildCandidate({
      text, type: TRIGGER_TYPE_MAP.scale, start: wordStartOf({ context, token }), end: wordEndOf({ context, token: tokenList[endIndex] }),
    }));
  });
  return candidateList.filter(Boolean);
}

// 접두사가 갈라져 나온 명사는 붙여서 읽는다("최/XPN 하위/NNG" → 최하위).
function readJoinedNoun({ tokenList, index }) {
  const token = tokenList[index];
  const previous = tokenList[index - 1];
  if (previous?.tag === 'XPN' && previous.end === token.start) return { form: previous.form + token.form, startIndex: index - 1 };
  return { form: token.form, startIndex: index };
}

// 명사 뒤 조사·접미사(권)를 건너 첫 술어. 줄기 위치와 술어 끝 토큰 위치를 돌려준다.
function findPredicateAfterNoun({ tokenList, index, maxDistance = 4 }) {
  for (let cursor = index + 1; cursor < tokenList.length && cursor <= index + maxDistance; cursor += 1) {
    const token = tokenList[cursor];
    if (/^J/.test(token.tag) || token.tag === 'XSN') continue;
    if (token.tag === 'NNG' && ['XSV', 'XSA'].includes(tokenList[cursor + 1]?.tag)) return { stemIndex: cursor, endIndex: cursor + 1 };
    if (PREDICATE_VERB_TAG_SET.has(token.tag) || PREDICATE_ADJ_TAG_SET.has(token.tag) || token.tag === 'VCP') {
      return { stemIndex: cursor, endIndex: cursor };
    }
    return null;
  }
  return null;
}

// 술어와 함께 한 구가 되는 변화·비교 명사: 최상·극값("사상 최저를 기록했습니다"), 추세("오름세를 보였어요", "증가 추세를 보이고"),
// 정해진 술어와 쓰는 명사("바닥을 찍었습니다", "차이가 없었어요", "흑자로 돌아섰습니다", "동률을 이뤘습니다").
function detectKoreanAnchoredChange(context) {
  const { tokenList, text } = context;
  const candidateList = [];
  tokenList.forEach((token, index) => {
    if (token.tag !== 'NNG') return;
    const { form, startIndex } = readJoinedNoun({ tokenList, index });
    let anchorEndIndex = index;
    let allowedStemSet = null;
    if (CHANGE_NOUN_SET.has(form) && tokenList[index + 1]?.form === '추세') {
      anchorEndIndex = index + 1;
    } else if (ANCHOR_PREDICATE_MAP.has(form)) {
      allowedStemSet = ANCHOR_PREDICATE_MAP.get(form);
    } else if (COMPARISON_NOUN_SET.has(form)) {
      allowedStemSet = COMPARISON_NOUN_PREDICATE_SET;
    } else if (!SUPERLATIVE_NOUN_SET.has(form) && !TREND_NOUN_SET.has(form)) {
      return;
    }
    const predicate = findPredicateAfterNoun({ tokenList, index: anchorEndIndex });
    if (!predicate) return;
    if (allowedStemSet && !allowedStemSet.has(tokenList[predicate.stemIndex].form)) return;
    const following = tokenList[predicate.endIndex + 1];
    if (following?.tag === 'ETM' || endsInModifier({ tokenList, index: predicate.endIndex })) return;
    if (following?.tag === 'EC' && PURPOSE_ENDING_SET.has(following.form)) return;
    if (isPlannedChange({ tokenList, stemIndex: predicate.stemIndex })) return;
    let startWordIndex = context.wordOf(tokenList[startIndex]);
    const previousWord = startWordIndex > 0 ? context.wordSpanList[startWordIndex - 1] : null;
    if (previousWord && SUPERLATIVE_PREFIX_WORD_SET.has(text.slice(previousWord.start, previousWord.end))) startWordIndex -= 1;
    const start = extendStartOverAdverbial({ context, startWordIndex });
    candidateList.push(buildCandidate({
      text, type: TRIGGER_TYPE_MAP.change, start, end: wordEndOf({ context, token: tokenList[predicate.endIndex] }),
    }));
  });
  return candidateList.filter(Boolean);
}

function detectKoreanCandidateList({ text, tokenList }) {
  const context = createKoreanContext({ text, tokenList });
  return dedupeCandidateList([
    ...detectKoreanDemonstrative(context),
    ...detectKoreanAdjectiveNoun(context),
    ...detectKoreanNumber(context),
    ...detectKoreanChange(context),
    ...detectKoreanAnchoredChange(context),
    ...detectKoreanScale(context),
    ...detectKoreanScaleAdverb(context),
    ...detectKoreanProportion(context),
  ]);
}

// ── 한국어 대체 규칙 (Kiwi 모델이 없거나 아직 준비되지 않았을 때) ──
// 형태소 분석 없이 어절 경계로만 맞춘다. 정확도가 낮으니 설치본에서는 쓰이지 않아야 한다.

const RULE_PATTERN_LIST = [
  { type: TRIGGER_TYPE_MAP.demonstrative, pattern: /(?<=^|\s)(?:이|그|저|요)\s+(?!때|정도|동안|후|전|다음|중|뒤|앞)[가-힣]+?(?=[은는이가을를의에도만]|\s|$)/g },
  { type: TRIGGER_TYPE_MAP.demonstrative, pattern: /(?<=^|\s)(?:이거|그거|저거|요거|이것|그것|저것|여기|거기|저기|요기|이곳|그곳|저곳|이쪽|그쪽|저쪽)(?=[가-힣]{0,3}(?:\s|$|[.,?!]))/g },
  { type: TRIGGER_TYPE_MAP.demonstrative, pattern: /(?<=^|\s)(?:이|그|저|요)렇게/g },
  { type: TRIGGER_TYPE_MAP.adjectiveNoun, pattern: /(?<=^|\s)[가-힣]*(?:[ㄱ-ㅎ가-힣](?:은|운|은|한|간|른|은))\s(?:쪽|부분|거|것|곳)(?=[가-힣]{0,2}(?:\s|$|[.,?!]))/g },
  { type: TRIGGER_TYPE_MAP.number, pattern: /\d[\d,.]*\s*(?:천|만|억|조)?\s*(?:%|퍼센트|프로|배|명|원|건|개|곳|위|점|톤|초|리터|킬로|달러|시간|개월|장|대)/g },
  { type: TRIGGER_TYPE_MAP.change, pattern: /(?:(?:결국|따라서|훨씬|더|많이|크게|대폭)\s+)?[가-힣]*(?:올랐|떨어졌|늘었|줄었|증가했|감소했|상승했|하락했|높아졌|낮아졌|좋아졌|나빠졌|커졌|작아졌|바뀌었|달라졌)[가-힣]*/g },
  { type: TRIGGER_TYPE_MAP.scale, pattern: /(?:(?:꽤|정말|엄청|되게|아주|굉장히|너무|좀|진짜|매우)\s+)(?:크|작|길|짧|넓|좁|많|적)[가-힣]*(?:다|죠|요|네요|습니다|ㅂ니다)/g },
];

function detectKoreanCandidateListByRule({ text }) {
  const candidateList = [];
  for (const { type, pattern } of RULE_PATTERN_LIST) {
    for (const match of text.matchAll(pattern)) {
      candidateList.push(buildCandidate({ text, type, start: match.index, end: match.index + match[0].length }));
    }
  }
  return dedupeCandidateList(candidateList.filter(Boolean));
}

// ── 영어 ──

const EN_STOP_FOLLOW_SET = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should',
  'may', 'might', 'must', 'do', 'does', 'did', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'and', 'or',
  'but', 'so', 'because', 'if', 'then', 'than', 'as', 'that', 'this', 'these', 'those', 'we', 'you', 'they', 'i', 'it',
  'he', 'she', 'the', 'a', 'an', 'our', 'your', 'their', 'my', 'is', 'just', 'really', 'also', 'still', 'right', 'here',
  'there', 'now', 'again', 'too', 'all', 'one', 'up', 'down', 'out', 'over', 'about', 'like', 'not', 'when', 'where',
]);
const EN_NUMBER_WORD_SET = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'twenty', 'thirty',
  'forty', 'fifty', 'hundred', 'thousand', 'million', 'billion', 'half', 'dozen',
]);
// "I think that …", "so that …"처럼 접속사·관계사 that 앞에 오는 말.
const EN_COMPLEMENTIZER_PREV_SET = new Set([
  'say', 'said', 'says', 'think', 'thought', 'know', 'knew', 'believe', 'mean', 'means', 'meant', 'show', 'shows',
  'showed', 'shown', 'so', 'such', 'now', 'sure', 'hope', 'found', 'find', 'see', 'saw', 'realize', 'realized', 'notice',
  'noticed', 'note', 'guess', 'feel', 'felt', 'agree', 'suggest', 'suggests', 'expect', 'assume', 'figure', 'figured',
  'learned', 'told', 'tell', 'clear', 'true', 'possible', 'likely', 'glad', 'afraid', 'aware', 'fact', 'idea', 'reason',
  'ensure', 'given', 'except', 'way', 'than', 'heard', 'remember', 'confirm', 'confirmed', 'decided', 'means',
]);
const EN_CLAUSE_START_SET = new Set([
  'we', 'you', 'they', 'i', 'he', 'she', 'it', 'there', 'the', 'a', 'an', 'our', 'your', 'their', 'my', 'his', 'her',
  'its', 'some', 'most', 'many', 'no', 'any', 'every', 'each', 'people', 'everyone', 'nobody', 'somebody',
]);
const EN_BE_SET = new Set(['is', 'are', 'was', 'were', "isn't", "aren't", "wasn't", "weren't"]);
const EN_MODAL_SET = new Set(['will', 'might', 'may', 'could', 'should', 'must', 'would', 'can', "won't", "can't"]);
// "There's our bottleneck"처럼 소유격·정관사가 오면 가리키는 there, "there's a problem"이면 존재문 there 다.
const EN_POINTING_AFTER_THERE_SET = new Set(['our', 'your', 'my', 'his', 'her', 'their', 'the', 'that', 'this']);

function isExistentialThere({ entry, next, nextNext }) {
  const isContracted = entry.lower !== 'there';
  const isBeNext = Boolean(next && EN_BE_SET.has(next.lower));
  if (isContracted || isBeNext) {
    const beFollower = isContracted ? next : nextNext;
    return !(beFollower && EN_POINTING_AFTER_THERE_SET.has(beFollower.lower));
  }
  if (next && EN_MODAL_SET.has(next.lower)) return nextNext?.lower === 'be';
  if (next && ['has', 'have', 'had'].includes(next.lower)) return nextNext?.lower === 'been';
  return Boolean(next && ['seems', 'seem', 'appears', 'appear', 'used', 'remains', 'exists'].includes(next.lower));
}
const EN_ADJ_NOUN_EXCLUDE_SET = new Set(['same', 'other', 'only', 'whole', 'next', 'last', 'first', 'second', 'third', 'very', 'right']);
const EN_UNIT_PATTERN_TEXT = [
  '%', 'percent', 'percentage points?', 'points?', 'times', 'x', 'people', 'persons?', 'users?', 'customers?',
  'students?', 'patients?', 'employees?', 'visitors?', 'members?', 'households?', 'dollars?', 'bucks', 'cents?', 'euros?',
  'won', 'yen', 'pounds?', 'kilograms?', 'kg', 'grams?', 'g', 'milligrams?', 'mg', 'tons?', 'tonnes?', 'liters?',
  'litres?', 'gallons?', 'meters?', 'metres?', 'm', 'km', 'kilometers?', 'miles?', 'feet', 'foot', 'inches?', 'cm',
  'mm', 'hours?', 'minutes?', 'seconds?', 'milliseconds?', 'ms', 'days?', 'weeks?', 'months?', 'units?', 'items?', 'cases?', 'calls?',
  'orders?', 'tickets?', 'trucks?', 'cars?', 'acres?', 'hectares?', 'degrees?', 'votes?', 'copies', 'pages?',
  'trips?', 'shipments?', 'reports?', 'complaints?', 'samples?', 'beds?', 'rooms?', 'stores?', 'sites?',
  'rpm', 'kwh', 'mwh', 'gwh', 'kw', 'mw', 'watts?', 'kilowatts?', 'kilowatt-hours?', 'megawatts?', 'volts?', 'amps?',
  'hz', 'khz', 'mhz', 'ghz', 'hertz', 'psi', 'kpa', 'mph', 'kph', 'decibels?', 'db', 'lbs?', 'ounces?', 'oz',
  'kb', 'mb', 'gb', 'tb', 'kilobytes?', 'megabytes?', 'gigabytes?', 'terabytes?', 'fps', 'kcal', 'calories?',
  '(?:square|sq|cubic) (?:meters?|metres?|feet|foot|kilometers?|km|miles?|inches?|yards?|centimeters?|cm|m|ft)',
].join('|');
// 단위 목록에 없는 복수 명사("31 cups", "12 benches", "9.6 newton-meters")도 개수·단위로 본다.
const EN_PLURAL_COUNT_PATTERN = /\b\d[\d,]*(?:\.\d+)?\s(?!(?:is|was|has|its|this|us|yes|plus|always|perhaps|as|was)\b)[a-z]{2,}(?:-[a-z]+)*s\b/gi;
const EN_NUMBER_PATTERN = new RegExp(
  `(?:\\$\\s?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:million|billion|thousand|k|m|bn)\\b)?`
  + `|\\b(?:\\d[\\d,]*(?:\\.\\d+)?|${[...EN_NUMBER_WORD_SET].join('|')})(?:\\s(?:hundred|thousand|million|billion))?\\s?(?:${EN_UNIT_PATTERN_TEXT})(?![a-z]))`,
  'gi',
);
// 목적어를 받으면 값의 변화가 아니다("dropped off the samples", "shifted the meeting").
const EN_OBJECT_START_TEXT = '(?:the|a|an|our|their|your|my|his|her|its|this|that|these|those|some|them|it|him|me|us|at)';
const EN_CHANGE_VERB_TEXT = [
  `dropped off(?!\\s+${EN_OBJECT_START_TEXT}\\b)`, 'stretch(?:es|ed) out', 'shift(?:s|ed) (?:to|toward|towards|up|down|upward|downward|higher|lower)',
  '(?:came|come|comes|coming) in (?:below|above|under|over|lower|higher|ahead of|behind|short of)',
  'expand(?:s|ed)', 'contract(?:s|ed)',
  'increas(?:e|es|ed|ing)', 'decreas(?:e|es|ed|ing)', 'drop(?:s|ped|ping)?', 'fell', 'fall(?:s|en|ing)?', 'rose',
  'ris(?:e|es|en|ing)', 'grew', 'grow(?:s|n|ing)?', 'doubled', 'tripled', 'halved', 'declin(?:e|es|ed|ing)',
  'improv(?:e|es|ed|ing)', 'jump(?:s|ed)?', 'climb(?:s|ed)?', 'surg(?:e|es|ed)', 'shrank', 'shrunk', 'shrinks?',
  'dipped', 'dips?', 'spik(?:e|es|ed)', 'plung(?:e|es|ed)', 'soar(?:s|ed)?', 'slipped', 'tank(?:s|ed)', 'skyrocketed',
  '(?:went|go|goes|gone|going|came|come|comes|coming|fell|falls) (?:way |all the way |back )?(?:up|down|off)', 'took off', 'outsold', 'outperform(?:s|ed)?', 'overtook', 'tripled',
  'slowed(?: down)?', 'sped up', 'picked up', 'shot up', 'crept up', 'ticked (?:up|down)', 'bounced back', 'recovered',
  'outperforming', 'crash(?:es|ed)?', 'collapsed', 'trailing', 'lagging', 'beating',
  'cut', 'reduced', 'boosted', 'brought \\w+ (?:down|up)', 'beat', 'trail(?:s|ed)', 'lagged', 'worsened', 'narrowed', 'widened',
].join('|');
const EN_COMPARATIVE_TEXT = [
  'higher', 'lower', 'bigger', 'smaller', 'larger', 'better', 'worse', 'faster', 'slower', 'cheaper', 'pricier',
  'more expensive', 'fewer', 'greater', 'shorter', 'longer', 'wider', 'narrower', 'stronger', 'weaker', 'heavier',
  'lighter', 'taller', 'safer', 'quicker', 'more', 'less',
].join('|');
const EN_MODIFIER_TEXT = '(?:(?:much|way|far|a lot|a bit|slightly|even|significantly|clearly|ultimately|eventually|steadily|sharply|dramatically|really)\\s+)*';
const EN_TRAIL_TEXT = '(?:\\s+(?:really\\s+|very\\s+|so\\s+)?(?:fast|quickly|slowly|sharply|steadily|a lot|a bit|quite a bit|significantly|dramatically|like a rock|off a cliff|in the end))?';
// "-er than"은 대개 비교급이지만 rather·other 같은 말도 있다.
const EN_NON_COMPARATIVE_ER_TEXT = '(?:rather|other|never|ever|over|under|after|whether|either|neither|later|together)';
const EN_CHANGE_PATTERN_LIST = [
  new RegExp(`\\b${EN_MODIFIER_TEXT}(?:${EN_CHANGE_VERB_TEXT})\\b${EN_TRAIL_TEXT}`, 'gi'),
  new RegExp(`\\b${EN_MODIFIER_TEXT}(?:(?:${EN_COMPARATIVE_TEXT})|(?!${EN_NON_COMPARATIVE_ER_TEXT}\\b)[a-z]+er|(?:more|less)\\s+[a-z]+)(?:\\s+[a-z]+)?\\s+than\\b`, 'gi'),
  new RegExp(`\\b(?:ultimately|eventually|finally)\\s+[a-z]+(?:\\s+(?:me|us|them|it|you))?\\s+(?:${EN_COMPARATIVE_TEXT}|(?!${EN_NON_COMPARATIVE_ER_TEXT}\\b)[a-z]+er)\\b`, 'gi'),
  new RegExp(`\\b(?:came out|ended up|turned out|got|gets|is|are|was|were|became|looks?)\\s+${EN_MODIFIER_TEXT}(?:${EN_COMPARATIVE_TEXT})\\b${EN_TRAIL_TEXT}`, 'gi'),
  new RegExp('\\bcompared (?:to|with)\\b', 'gi'),
  new RegExp('\\b(?:(?:well|way|far|just|slightly|still|now)\\s+)(?:above|below|ahead of|behind)\\b', 'gi'),
];
const EN_CONCLUSION_PATTERN = /\b(?:in the end|ultimately|eventually|so in the end|all in all|as a result)\b/gi;
const EN_SCALE_ADJ_TEXT = 'big|small|large|huge|tiny|long|short|wide|narrow|tall|many|few';
const EN_INTENSIFIER_TEXT = "really|very|so|super|pretty|quite|incredibly|extremely|way too|too|fairly|kind of|kinda|awfully|crazy|insanely|seriously|enormously|remarkably|surprisingly";
const EN_SCALE_PATTERN_LIST = [
  new RegExp(`\\b(?:(?:${EN_INTENSIFIER_TEXT})\\s+)+(?:${EN_SCALE_ADJ_TEXT})\\b`, 'gi'),
  new RegExp(`(?<=\\b(?:is|are|was|were|looks?|seems?|got|gets|get)\\s)(?:${EN_SCALE_ADJ_TEXT})\\b(?!\\s+than)`, 'gi'),
];

// 값의 변화가 아닌 쓰임: 주어 명사("Crashes went down"), 구동사·관용구("drop off", "falls apart", "jumped out", "cut from"),
// 계절의 fall, 횟수를 센 crashed twice, 명사를 꾸미는 -ing("the growing season").
const EN_SUBJECT_FOLLOW_PATTERN = /^\s+(?:has|have|had|is|are|was|were|went|goes|go|rose|fell|will)\b/i;
const EN_NON_VALUE_CHANGE_RULE_LIST = [
  { head: /^cut$/i, after: /^\s+(?:from|is|was|are|were)\b/i },
  // "drop the sensor"처럼 목적어를 받으면 내려놓기다. "dropped a ton", "dropped a great deal"의 a 는 변화량이라 남긴다.
  { head: /^drop(?:s|ped|ping)?$/i, after: /^\s+(?:off|the|our|their|your|my|it|them|this|that)\b|^\s+an?\s+(?!(?:ton|great deal|lot|bit|little|good bit|fair bit|whole lot)\b)/i },
  { head: /^fall(?:s|ing)?$/i, after: /^\s+apart\b/i },
  { head: /^fall$/i, before: /\b(?:next|last|this|early|late|in the)\s+$/i },
  { head: /^crash(?:es|ed)?$/i, after: /^\s+(?:twice|once|again|\d+\s+times|(?:two|three|four|five|several|many)\s+times)\b/i },
  { head: /^jump(?:s|ed)?$/i, after: /^\s+out\b/i },
  // "expanded their team", "contracted a local vendor"처럼 목적어를 받으면 늘리기·계약이다.
  { head: /^(?:expand|contract)(?:s|ed)$/i, after: new RegExp(`^\\s+(?:${EN_OBJECT_START_TEXT}|with|for)\\b`, 'i') },
  { head: /^[a-z]+ing$/i, before: /\bthe\s+$/i },
];
// "over the eight weeks"처럼 기간을 나타내는 수는 화면 수치가 아니다.
const EN_PERIOD_BEFORE_PATTERN = /\b(?:over|for|during|in)\s+the\s+(?:past\s+|last\s+|next\s+|first\s+)?$/i;
const EN_PERIOD_UNIT_PATTERN = /\b(?:days?|weeks?|months?|years?|hours?)$/i;

function isNonValueEnglishChange({ text, candidate }) {
  const phrase = text.slice(candidate.start, candidate.end);
  if (/\s/.test(phrase.trim())) return false;
  const before = text.slice(0, candidate.start);
  const after = text.slice(candidate.end);
  if (EN_SUBJECT_FOLLOW_PATTERN.test(after)) return true;
  return EN_NON_VALUE_CHANGE_RULE_LIST.some((rule) => rule.head.test(phrase)
    && (!rule.after || rule.after.test(after)) && (!rule.before || rule.before.test(before)));
}

function isEnglishPeriodNumber({ text, candidate }) {
  const phrase = text.slice(candidate.start, candidate.end);
  return EN_PERIOD_UNIT_PATTERN.test(phrase) && EN_PERIOD_BEFORE_PATTERN.test(text.slice(0, candidate.start));
}

function listEnglishWord(text) {
  return [...text.matchAll(/[A-Za-z']+/g)].map((match) => ({
    word: match[0], lower: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length,
  }));
}

function detectEnglishDemonstrative({ text, wordList }) {
  const candidateList = [];
  wordList.forEach((entry, index) => {
    const previous = wordList[index - 1];
    const next = wordList[index + 1];
    const isAdjacentNext = next && /^\s+$/.test(text.slice(entry.end, next.start));
    const baseLower = entry.lower.replace(/'s$/, '');
    if (['this', 'these', 'those', 'that'].includes(baseLower)) {
      if (baseLower !== entry.lower) {
        candidateList.push(buildCandidate({ text, type: TRIGGER_TYPE_MAP.demonstrative, start: entry.start, end: entry.start + baseLower.length }));
        return;
      }
      if (entry.lower === 'that') {
        if (previous && EN_COMPLEMENTIZER_PREV_SET.has(previous.lower)) return;
        if (isAdjacentNext && EN_CLAUSE_START_SET.has(next.lower)) return;
      }
      let end = entry.end;
      let cursor = index;
      for (let step = 0; step < 2; step += 1) {
        const following = wordList[cursor + 1];
        if (!following || !/^\s+$/.test(text.slice(wordList[cursor].end, following.start))) break;
        if (EN_STOP_FOLLOW_SET.has(following.lower) && !EN_NUMBER_WORD_SET.has(following.lower)) break;
        end = following.end;
        cursor += 1;
        if (!EN_NUMBER_WORD_SET.has(following.lower)) break;
      }
      candidateList.push(buildCandidate({ text, type: TRIGGER_TYPE_MAP.demonstrative, start: entry.start, end }));
      return;
    }
    if (entry.lower === 'here' || entry.lower === "here's") {
      candidateList.push(buildCandidate({ text, type: TRIGGER_TYPE_MAP.demonstrative, start: entry.start, end: entry.start + 4 }));
      return;
    }
    if (entry.lower === 'there' || entry.lower === "there's" || entry.lower === "there're") {
      if (!isExistentialThere({ entry, next, nextNext: wordList[index + 2] })) {
        candidateList.push(buildCandidate({ text, type: TRIGGER_TYPE_MAP.demonstrative, start: entry.start, end: entry.start + 5 }));
      }
    }
  });
  return candidateList.filter(Boolean);
}

function detectEnglishAdjectiveNoun({ text }) {
  const candidateList = [];
  for (const match of text.matchAll(/\bthe\s+(?:(?:most|least)\s+)?([a-z]+(?:-[a-z]+)*)\s+(?:one|ones|side|sides|part|parts)\b/gi)) {
    if (EN_ADJ_NOUN_EXCLUDE_SET.has(match[1].toLowerCase())) continue;
    candidateList.push(buildCandidate({ text, type: TRIGGER_TYPE_MAP.adjectiveNoun, start: match.index, end: match.index + match[0].length }));
  }
  return candidateList.filter(Boolean);
}

function collectPatternCandidateList({ text, type, patternList }) {
  const candidateList = [];
  for (const pattern of patternList) {
    for (const match of text.matchAll(pattern)) {
      candidateList.push(buildCandidate({ text, type, start: match.index, end: match.index + match[0].length }));
    }
  }
  return candidateList.filter(Boolean);
}

function attachEnglishConclusion({ text, candidate }) {
  const sentenceStart = Math.max(text.lastIndexOf('.', candidate.start - 1), text.lastIndexOf('?', candidate.start - 1),
    text.lastIndexOf('!', candidate.start - 1)) + 1;
  const sentenceEndMatch = /[.?!]/.exec(text.slice(candidate.end));
  const sentenceEnd = sentenceEndMatch ? candidate.end + sentenceEndMatch.index : text.length;
  for (const match of text.slice(sentenceStart, sentenceEnd).matchAll(EN_CONCLUSION_PATTERN)) {
    const markerStart = sentenceStart + match.index;
    const markerEnd = markerStart + match[0].length;
    if (markerEnd <= candidate.start && candidate.start - markerEnd <= 30) {
      return buildCandidate({ text, type: candidate.type, start: markerStart, end: candidate.end }) || candidate;
    }
    if (markerStart >= candidate.end && markerStart - candidate.end <= 30) {
      return buildCandidate({ text, type: candidate.type, start: candidate.start, end: markerEnd }) || candidate;
    }
  }
  return candidate;
}

function mergeOverlapping(candidateList) {
  const sortedList = [...candidateList].sort((left, right) => left.start - right.start);
  const mergedList = [];
  for (const candidate of sortedList) {
    const last = mergedList[mergedList.length - 1];
    if (last && last.type === candidate.type && candidate.start <= last.end) {
      last.end = Math.max(last.end, candidate.end);
    } else {
      mergedList.push({ ...candidate });
    }
  }
  return mergedList;
}

function detectEnglishCandidateList({ text }) {
  const wordList = listEnglishWord(text);
  const changeList = mergeOverlapping(collectPatternCandidateList({ text, type: TRIGGER_TYPE_MAP.change, patternList: EN_CHANGE_PATTERN_LIST }))
    .map((candidate) => buildCandidate({ text, type: candidate.type, start: candidate.start, end: candidate.end }))
    .filter(Boolean)
    .filter((candidate) => !isNonValueEnglishChange({ text, candidate }))
    .map((candidate) => attachEnglishConclusion({ text, candidate }));
  const scaleList = collectPatternCandidateList({ text, type: TRIGGER_TYPE_MAP.scale, patternList: EN_SCALE_PATTERN_LIST })
    .filter((candidate) => !changeList.some((change) => candidate.start < change.end && change.start < candidate.end));
  return dedupeCandidateList([
    ...detectEnglishDemonstrative({ text, wordList }),
    ...detectEnglishAdjectiveNoun({ text }),
    ...mergeOverlapping(collectPatternCandidateList({
      text, type: TRIGGER_TYPE_MAP.number, patternList: [EN_NUMBER_PATTERN, EN_PLURAL_COUNT_PATTERN],
    })).filter((candidate) => !isEnglishPeriodNumber({ text, candidate })),
    ...changeList,
    ...mergeOverlapping(scaleList),
  ]);
}

// ── 진입점 ──

function createSpeechTrigger({ tokenizer = null } = {}) {
  function detect({ text }) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) return { language: null, analyzer: null, candidateList: [] };
    const language = detectTriggerLanguage(trimmed);
    if (language === TRIGGER_LANGUAGE_MAP.en) {
      return { language, analyzer: TRIGGER_ANALYZER_MAP.english, candidateList: detectEnglishCandidateList({ text: trimmed }) };
    }
    const tokenList = tokenizer?.tokenize(trimmed) || null;
    if (!tokenList) {
      return { language, analyzer: TRIGGER_ANALYZER_MAP.rule, candidateList: detectKoreanCandidateListByRule({ text: trimmed }) };
    }
    return { language, analyzer: TRIGGER_ANALYZER_MAP.kiwi, candidateList: detectKoreanCandidateList({ text: trimmed, tokenList }) };
  }

  return { detect };
}

module.exports = {
  createSpeechTrigger, detectKoreanCandidateList, detectKoreanCandidateListByRule, detectEnglishCandidateList,
  detectTriggerLanguage, TRIGGER_TYPE_MAP, TRIGGER_TYPE_LABEL_MAP, TRIGGER_LANGUAGE_MAP, TRIGGER_ANALYZER_MAP,
};
