// 해설 순간 발화와 가까운 화면 사실 카드를 고른다. 원리: 발표자가 부른 이름·숫자는 그 패널에 적혀 있다.
// GPU 서버에 글 임베딩이 없어 낱말 겹침으로 고르고(Kiwi 명사, 없으면 조사 떼기), 화면 제목처럼 모든 카드에 나오는 낱말은 약하게 친다.
// 가중치·문턱은 원리로 정한 시작값이다. 평가 DB 로 맞추지 않는다.
const { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP, INTERPRETATION_KIND_MAP } = require('../contracts/narration-types');
const { extractKeywordList } = require('../prompts/screen-text-block');
const { FACT_CARD_USAGE_MAP } = require('../prompts/fact-card-block');
const { SLIDE_TEXT_STATUS_MAP } = require('./slide-text-store');
const { isValuePresent, VALUE_PRESENCE_VERDICT_MAP } = require('./value-presence');
const { FACT_CARD_STATUS_MAP } = require('./fact-card-store');

// 에이전트별로 넘기는 최대 장수. 덩어리 글자 상한은 fact-card-block 이 맡는다.
const FACT_CARD_SELECT_LIMIT_MAP = {
  [FACT_CARD_USAGE_MAP.value]: 2,
  [FACT_CARD_USAGE_MAP.scale]: 1,
  [FACT_CARD_USAGE_MAP.deixis]: 1,
};
// SEEON_FACT_CARD_AGENTS 의 이름. 지시는 기본으로 받지 않는다 — 화면 글자를 주면 옆 상자의 값을 가리킨 대상에 붙였다.
const FACT_CARD_AGENT_MAP = { interpretation: 'interpretation', scale: 'scale', deixis: 'deixis' };

const FACT_CARD_TITLE_WEIGHT = 3;
const FACT_CARD_BODY_WEIGHT = 2;
const FACT_CARD_NUMBER_WEIGHT = 3;
const FACT_CARD_CONTEXT_WEIGHT = 0.5;
const FACT_CARD_PARTIAL_HIT = 0.5;
const FACT_CARD_MIN_SCORE = 2;
const FACT_CARD_RELATIVE_SCORE = 0.5;
const FACT_CARD_DEIXIS_MIN_SCORE = 3;
// 앞 발화는 끝부분만 본다(앞 화제로 두 패널 중 하나를 고르는 데 쓴다). 뒤 발화는 실시간이라 쓰지 않는다.
const FACT_CARD_CONTEXT_TAIL_CHARS = 80;
// 같은 프레임 OCR 글자에 카드 낱말이 이 비율보다 적게 나오면 지금 화면의 카드가 아니라고 본다. 낱말이 적은 카드는 가르지 않는다.
const FACT_CARD_FRESH_MIN_WORD_COUNT = 3;
const FACT_CARD_FRESH_MIN_RATIO = 0.3;
const FACT_CARD_FRESH_MAP = { ok: 'ok', unchecked: 'unchecked', stale: 'stale' };
const FACT_CARD_SKIP_REASON_MAP = { beforeCardFrame: 'before_card_frame' };

const HANGUL_PATTERN = /[가-힣]/;
const KIWI_NOUN_TAG_SET = new Set(['NNG', 'NNP']);
const KIWI_NOUN_SUFFIX_TAG = 'XSN';
const MIN_HANGUL_WORD_LENGTH = 2;
// 카드 글자는 장마다 같은 것을 해설마다 다시 분석하므로 글자별로 낱말을 기억해 둔다(빽빽한 장에서 고르기 한 번이 수십 ms 걸린다).
const WORD_LIST_CACHE_LIMIT = 5000;

function normalizeDigitGrouping(text) {
  return String(text || '').replace(/(\d),(?=\d)/g, '$1');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 앞뒤가 다른 숫자로 이어지면 같은 수가 아니다("52" 는 "520"·"52.5" 와 다르다).
function containsNumberCore({ text, core }) {
  return new RegExp(`(?<![\\d.])${escapeRegExp(core)}(?!\\d|\\.\\d)`).test(normalizeDigitGrouping(text));
}

function isHangulWord(word) {
  return HANGUL_PATTERN.test(word);
}

// Kiwi 명사(NNG·NNP)와, 붙어 있는 명사·접미사 줄(지역/NNG 별/XSN → "지역별")을 이어 붙인 꼴을 함께 뽑는다.
function extractKiwiNounList(tokenList) {
  const wordSet = new Set();
  const addWord = (word) => { if (word.length >= MIN_HANGUL_WORD_LENGTH && isHangulWord(word)) wordSet.add(word); };
  let run = [];
  const flush = () => {
    if (run.length > 1) addWord(run.map((token) => token.form).join(''));
    run = [];
  };
  for (const token of tokenList) {
    const isNoun = KIWI_NOUN_TAG_SET.has(token.tag);
    if (!isNoun && token.tag !== KIWI_NOUN_SUFFIX_TAG) {
      flush();
      continue;
    }
    if (run.length && run.at(-1).end !== token.start) flush();
    if (isNoun) addWord(token.form);
    if (isNoun || run.length) run.push(token);
  }
  flush();
  return [...wordSet];
}

// 발화 쪽과 카드 쪽 낱말을 같은 방법으로 뽑는다. 한글은 Kiwi 가 준비됐으면 명사로, 아니면 조사를 뗀 낱말로 본다.
// 영어 낱말(소문자, 세 글자 이상, 흔한 기능어 제외)과 숫자(두 자리 이상, 천 단위 쉼표 무시)는 전사 줄 고르기와 같은 규칙이다.
function createFactCardTokenizer({ kiwiTokenizer = null } = {}) {
  const isKiwiReady = () => Boolean(kiwiTokenizer?.isReady?.());
  const wordListCache = new Map();

  function analyzeWordList(source) {
    const { wordList } = extractKeywordList([source]);
    const tokenList = isKiwiReady() ? kiwiTokenizer.tokenize(source) : null;
    if (!tokenList) return wordList;
    return [...new Set([...extractKiwiNounList(tokenList), ...wordList.filter((word) => !isHangulWord(word))])];
  }

  // 돌려준 목록은 기억해 둔 것과 같으므로 호출부가 바꾸지 않는다. Kiwi 가 뒤늦게 준비되면 다른 열쇠로 다시 분석한다.
  function extractWordList(text) {
    const source = String(text || '');
    if (!source.trim()) return [];
    const key = `${isKiwiReady() ? 'kiwi' : 'rule'}\u0000${source}`;
    const cached = wordListCache.get(key);
    if (cached) return cached;
    const wordList = analyzeWordList(source);
    if (wordListCache.size >= WORD_LIST_CACHE_LIMIT) wordListCache.clear();
    wordListCache.set(key, wordList);
    return wordList;
  }

  function extractNumberCoreList(text) {
    return extractKeywordList([String(text || '')]).numberCoreList;
  }

  return { extractWordList, extractNumberCoreList, isKiwiReady };
}

function uniqueWordList(textList, tokenizer) {
  return [...new Set(textList.filter(Boolean).flatMap((text) => tokenizer.extractWordList(text)))];
}

// 주 출처: 트리거 발화와 판단 LLM 이 고른 근거 표현. 문맥 출처: 앞 발화 끝 80자(주 출처에 없는 낱말·숫자만).
function buildFactCardQuery({ utterance = '', anchorList = [], beforeText = '', tokenizer }) {
  const mainTextList = [utterance, ...anchorList].filter((text) => typeof text === 'string' && text.trim());
  const wordList = uniqueWordList(mainTextList, tokenizer);
  const numberCoreList = [...new Set(mainTextList.flatMap((text) => tokenizer.extractNumberCoreList(text)))];
  const contextText = String(beforeText || '').slice(-FACT_CARD_CONTEXT_TAIL_CHARS);
  return {
    wordList,
    numberCoreList,
    contextWordList: tokenizer.extractWordList(contextText).filter((word) => !wordList.includes(word)),
    contextNumberCoreList: tokenizer.extractNumberCoreList(contextText).filter((core) => !numberCoreList.includes(core)),
  };
}

// 제목 칸: 패널 제목·화면 제목. 이름 칸: 항목 이름·범례·머리글·축 이름·조건·기간. 숫자 칸: 값·눈금·기간.
function readCardTerms({ card, screenTitle, tokenizer }) {
  return {
    titleWordList: uniqueWordList([card.title, screenTitle], tokenizer),
    bodyWordList: uniqueWordList([
      ...card.itemList.map((item) => item.label), ...card.legendList, ...card.headerList,
      ...card.axisList.map((axis) => axis.name), ...card.itemList.map((item) => item.note), card.period,
    ], tokenizer),
    numberText: [
      ...card.itemList.map((item) => item.value), ...card.axisList.flatMap((axis) => [axis.from, axis.to]), card.period,
    ].filter(Boolean).join('\n'),
  };
}

// 같은 낱말이면 1, 한글 두 글자 이상 낱말이 서로 포함되면 0.5("매출" ⊂ "매출액").
function readWordHit(word, wordList) {
  let hit = 0;
  for (const candidate of wordList) {
    if (candidate === word) return 1;
    if (isHangulWord(word) && isHangulWord(candidate) && (candidate.includes(word) || word.includes(candidate))) {
      hit = FACT_CARD_PARTIAL_HIT;
    }
  }
  return hit;
}

function roundScore(score) {
  return Math.round(score * 100) / 100;
}

// score = Σ idf(u)·(3·제목 맞춤 + 2·이름 맞춤) + Σ 3·[숫자 맞춤] + 0.5·(앞 발화로 같은 계산), idf(u) = 1/(u 가 맞는 카드 수)
function scoreFactCardList({ cardList = [], screenTitle = '', query, tokenizer }) {
  const termsList = cardList.map((card) => readCardTerms({ card, screenTitle, tokenizer }));
  const hitPairOf = (terms, word) => [readWordHit(word, terms.titleWordList), readWordHit(word, terms.bodyWordList)];
  const idfOf = (word) => {
    const cardCount = termsList.filter((terms) => hitPairOf(terms, word).some(Boolean)).length;
    return cardCount ? 1 / cardCount : 0;
  };
  const scoreBy = ({ terms, wordList, numberCoreList }) => {
    let score = 0;
    let hasNameHit = false;
    for (const word of wordList) {
      const [titleHit, bodyHit] = hitPairOf(terms, word);
      if (!titleHit && !bodyHit) continue;
      hasNameHit = true;
      score += idfOf(word) * (FACT_CARD_TITLE_WEIGHT * titleHit + FACT_CARD_BODY_WEIGHT * bodyHit);
    }
    score += FACT_CARD_NUMBER_WEIGHT * numberCoreList.filter((core) => containsNumberCore({ text: terms.numberText, core })).length;
    return { score, hasNameHit };
  };
  return cardList.map((card, index) => {
    const main = scoreBy({ terms: termsList[index], wordList: query.wordList, numberCoreList: query.numberCoreList });
    const context = scoreBy({
      terms: termsList[index], wordList: query.contextWordList, numberCoreList: query.contextNumberCoreList,
    });
    return { card, score: roundScore(main.score + FACT_CARD_CONTEXT_WEIGHT * context.score), hasNameHit: main.hasNameHit };
  });
}

// 발화 낱말이 항목 이름·조건에 맞거나 발화 숫자가 값에 있는 항목. 덩어리가 글자 상한 안에서 이 항목부터 담는다.
function findMatchedItemIndexList({ card, query, tokenizer }) {
  const indexList = [];
  card.itemList.forEach((item, index) => {
    const itemWordList = uniqueWordList([item.label, item.note], tokenizer);
    const isWordHit = query.wordList.some((word) => readWordHit(word, itemWordList));
    const isNumberHit = query.numberCoreList.some((core) => containsNumberCore({ text: item.value, core }));
    if (isWordHit || isNumberHit) indexList.push(index);
  });
  return indexList;
}

function compactText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '');
}

function isValueOnFrame({ value, frameText }) {
  if (!value) return true;
  const { verdict } = isValuePresent({
    value, slideText: frameText, slideTextStatus: SLIDE_TEXT_STATUS_MAP.ready, subKind: INTERPRETATION_KIND_MAP.claimToValue,
  });
  return verdict !== VALUE_PRESENCE_VERDICT_MAP.absent;
}

// 해설 순간 같은 프레임 OCR 로 옛 카드를 거른다. 같은 장으로 판정된 스크롤·대시보드 값 변화·늦은 장 번호에서 옛 카드가 섞이는 것을 막는다.
// ① 카드 제목·항목 이름 낱말이 OCR 글자에 30% 미만으로 나오면 그 카드를 뺀다. ② OCR 글자(점수와 상관없이 모든 줄)에 없는 숫자 값은 값만 비운다.
// OCR 이 없거나 못 믿는 결과(빈 줄 목록)면 거르지 않고 unchecked 로 남긴다. 그래도 값 존재 검사가 마지막 그물로 남는다.
function filterFreshFactCards({ cardList = [], frameLineList = [], tokenizer }) {
  const lineTextList = (Array.isArray(frameLineList) ? frameLineList : [])
    .map((line) => (typeof line?.text === 'string' ? line.text.trim() : '')).filter(Boolean);
  if (!lineTextList.length) {
    return { cardList, fresh: FACT_CARD_FRESH_MAP.unchecked, staleDroppedCount: 0, valueDroppedCount: 0 };
  }
  const frameText = lineTextList.join('\n');
  const frameCompact = compactText(frameText);
  let staleDroppedCount = 0;
  let valueDroppedCount = 0;
  const freshList = [];
  for (const card of cardList) {
    const wordList = uniqueWordList([card.title, ...card.itemList.map((item) => item.label)], tokenizer);
    const foundCount = wordList.filter((word) => frameCompact.includes(compactText(word))).length;
    if (wordList.length >= FACT_CARD_FRESH_MIN_WORD_COUNT && foundCount / wordList.length < FACT_CARD_FRESH_MIN_RATIO) {
      staleDroppedCount += 1;
      continue;
    }
    const itemList = card.itemList.map((item) => {
      if (isValueOnFrame({ value: item.value, frameText })) return item;
      valueDroppedCount += 1;
      return { ...item, value: '', isValueVerified: false };
    });
    freshList.push({ ...card, itemList });
  }
  const fresh = cardList.length && !freshList.length ? FACT_CARD_FRESH_MAP.stale : FACT_CARD_FRESH_MAP.ok;
  return { cardList: freshList, fresh, staleDroppedCount, valueDroppedCount };
}

function pickScoredList({ scoredList, usage, slideCardCount }) {
  // 카드가 1장뿐인 슬라이드는 화면 전체가 한 패널이라 엉뚱한 패널 위험이 없다(지시는 이름이 맞아야 준다).
  if (slideCardCount === 1 && usage !== FACT_CARD_USAGE_MAP.deixis) return scoredList;
  const topScore = Math.max(0, ...scoredList.map((entry) => entry.score));
  return scoredList.filter((entry) => entry.score >= FACT_CARD_MIN_SCORE
    && entry.score >= FACT_CARD_RELATIVE_SCORE * topScore
    && (usage !== FACT_CARD_USAGE_MAP.deixis || (entry.score >= FACT_CARD_DEIXIS_MIN_SCORE && entry.hasNameHit)));
}

// state: 카드 저장소의 그 장(major) 상태. 다른 장의 카드는 id 로 한 번 더 막는다.
function selectFactCards({ state, usage, utterance = '', anchorList = [], beforeText = '', frameLineList = [],
  requestTs = null, tokenizer = createFactCardTokenizer() }) {
  const major = String(state?.major ?? '');
  const slideCardList = (state?.cardList || []).filter((card) => major && String(card?.id || '').startsWith(`${major}:`));
  const record = {
    status: state?.status || FACT_CARD_STATUS_MAP.missing, cardCount: slideCardList.length, selectedIdList: [], scoreList: [],
    staleDroppedCount: 0, valueDroppedCount: 0, fresh: FACT_CARD_FRESH_MAP.unchecked, skipReason: null,
  };
  if (state?.status !== FACT_CARD_STATUS_MAP.ready || !slideCardList.length) return { cardList: [], record };
  if (Number.isFinite(requestTs) && Number.isFinite(state.frameTs) && requestTs < state.frameTs) {
    return { cardList: [], record: { ...record, skipReason: FACT_CARD_SKIP_REASON_MAP.beforeCardFrame } };
  }
  const freshness = filterFreshFactCards({ cardList: slideCardList, frameLineList, tokenizer });
  const query = buildFactCardQuery({ utterance, anchorList: anchorList.filter(Boolean), beforeText, tokenizer });
  const scoredList = scoreFactCardList({ cardList: freshness.cardList, screenTitle: state.screenTitle, query, tokenizer });
  const pickedList = pickScoredList({ scoredList, usage, slideCardCount: slideCardList.length })
    .sort((left, right) => right.score - left.score)
    .slice(0, FACT_CARD_SELECT_LIMIT_MAP[usage] ?? 0);
  return {
    cardList: pickedList.map(({ card }) => ({
      ...card, matchedItemIndexList: findMatchedItemIndexList({ card, query, tokenizer }),
    })),
    record: {
      ...record,
      selectedIdList: pickedList.map(({ card }) => card.id),
      scoreList: scoredList.map(({ card, score }) => ({ id: card.id, score })),
      staleDroppedCount: freshness.staleDroppedCount,
      valueDroppedCount: freshness.valueDroppedCount,
      fresh: freshness.fresh,
    },
  };
}

// 이번 해설 에이전트가 카드를 받는지와 어떤 덩어리로 받는지. 카드가 꺼져 있거나 목록에 없는 에이전트면 null.
function resolveFactCardUsage({ narrationType, subKind = null, isEnabled = false, agentList = [] }) {
  if (!isEnabled) return null;
  if (narrationType === NARRATION_TYPE_MAP.interpretation && agentList.includes(FACT_CARD_AGENT_MAP.interpretation)) {
    return FACT_CARD_USAGE_MAP.value;
  }
  if (narrationType === NARRATION_TYPE_MAP.visualDescription
    && (subKind || VISUAL_DESCRIPTION_KIND_MAP.scale) === VISUAL_DESCRIPTION_KIND_MAP.scale
    && agentList.includes(FACT_CARD_AGENT_MAP.scale)) {
    return FACT_CARD_USAGE_MAP.scale;
  }
  if (narrationType === NARRATION_TYPE_MAP.deixis && agentList.includes(FACT_CARD_AGENT_MAP.deixis)) {
    return FACT_CARD_USAGE_MAP.deixis;
  }
  return null;
}

// 해설 기록·흐름 창에 남길 한 줄 요약. 장수는 고른 장/그 장의 전체, 글자 수는 프롬프트에 실제로 들어간 양이다.
function formatFactCardSummary(record) {
  if (!record) return '사실 카드=없음';
  if (record.status !== FACT_CARD_STATUS_MAP.ready) {
    return `사실 카드=없음(${record.status}${record.waitedMs ? `, 대기 ${record.waitedMs}ms` : ''})`;
  }
  return `사실 카드=${record.selectedIdList.length}/${record.cardCount}장 ${record.charCount ?? 0}자`
    + ` fresh=${record.fresh} 대기 ${record.waitedMs ?? 0}ms${record.skipReason ? ` (${record.skipReason})` : ''}`;
}

module.exports = {
  createFactCardTokenizer, buildFactCardQuery, scoreFactCardList, filterFreshFactCards, selectFactCards,
  resolveFactCardUsage, formatFactCardSummary,
  FACT_CARD_AGENT_MAP, FACT_CARD_FRESH_MAP, FACT_CARD_SELECT_LIMIT_MAP, FACT_CARD_SKIP_REASON_MAP,
  FACT_CARD_MIN_SCORE, FACT_CARD_RELATIVE_SCORE, FACT_CARD_DEIXIS_MIN_SCORE, FACT_CARD_CONTEXT_TAIL_CHARS,
};
