const { normalizeNarrationClass, findBlockingRule, resolveMinIntervalMs } = require('./blocking-policy');

const DEFAULT_SIMILARITY_THRESHOLD = 0.58;
const PAGE_TRANSITION_SIMILARITY_THRESHOLD = 0.70;
const PAGE_TRANSITION_SOURCE = 'page-transition';
const DEFAULT_MAX_ENTRY = 400;

const TARGET_OVERLAP_THRESHOLD = 0.5;

const TARGET_STOPWORD_LIST = [
  '가리키며', '가리킴', '보는', '보며', '주목', '설명함', '설명', '중임', '중',
  '이런', '그런', '저런', '각종', '다양한', '여러', '해당', '관련', '항목', '부분',
];

const TARGET_PARTICLE_LIST = ['으로', '에서', '이랑', '와의', '과의', '을', '를', '이', '가', '은', '는', '의', '에', '와', '과', '도', '로'];

function normalizeNarration({ text }) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s.,!?~·:;'"“”‘’()[\]{}<>+\-–—/\\|]/g, '');
}

function buildBigramSet({ text }) {
  const set = new Set();
  if (text.length <= 1) { if (text) set.add(text); return set; }
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

function computeBigramSimilarity({ textA, textB }) {
  if (!textA || !textB) return 0;
  if (textA === textB) return 1;
  const setA = buildBigramSet({ text: textA });
  const setB = buildBigramSet({ text: textB });
  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
}

function createNarrationHistory({
  similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
  pageTransitionThreshold = PAGE_TRANSITION_SIMILARITY_THRESHOLD,
  targetOverlapThreshold = TARGET_OVERLAP_THRESHOLD,
  maxEntry = DEFAULT_MAX_ENTRY,
} = {}) {
  let entryList = [];

  // 대상 칸: 수치 해설은 target, 지시·척도 해설은 caption(가리킨 대상의 이름·내용, 견준 크기 묘사)이다.
  function buildTargetTokenSet({ slotMap }) {
    const targetText = slotMap?.target ?? slotMap?.caption;
    const raw = typeof targetText === 'string' ? targetText : '';
    if (!raw.trim()) return null;
    const tokenSet = new Set();
    for (let token of raw.toLowerCase().split(/[\s,·/()]+/)) {
      for (const stopword of TARGET_STOPWORD_LIST) token = token.split(stopword).join('');
      for (const particle of TARGET_PARTICLE_LIST) {
        if (token.length > particle.length + 1 && token.endsWith(particle)) {
          token = token.slice(0, -particle.length);
          break;
        }
      }
      if (token.length >= 2) tokenSet.add(token);
    }
    return tokenSet.size ? tokenSet : null;
  }

  function computeTargetOverlap({ setA, setB }) {
    if (!setA?.size || !setB?.size) return 0;
    let shared = 0;
    for (const token of setA) if (setB.has(token)) shared += 1;
    return shared / Math.min(setA.size, setB.size);
  }

  function resolveThreshold({ source }) {
    return source === PAGE_TRANSITION_SOURCE ? pageTransitionThreshold : similarityThreshold;
  }

  function findDuplicate({ text, source = '', slotMap = null, slideLabel = null }) {
    const threshold = resolveThreshold({ source });
    const normalized = normalizeNarration({ text });
    if (!normalized) {
      return { isDuplicate: false, matchedText: '', similarity: 0, reason: '', threshold };
    }
    const targetTokenSet = buildTargetTokenSet({ slotMap });
    let best = { matchedText: '', similarity: 0 };
    let bestTarget = { matchedText: '', similarity: 0 };
    for (const entry of entryList) {
      if (entry.normalized === normalized) {
        return {
          isDuplicate: true, matchedText: entry.text, similarity: 1, reason: 'exact', threshold,
        };
      }
      const similarity = computeBigramSimilarity({ textA: normalized, textB: entry.normalized });
      if (similarity > best.similarity) best = { matchedText: entry.text, similarity };
      if (targetTokenSet && entry.targetTokenSet && entry.slideLabel === slideLabel) {
        const overlap = computeTargetOverlap({
          setA: targetTokenSet, setB: entry.targetTokenSet,
        });
        if (overlap > bestTarget.similarity) {
          bestTarget = { matchedText: entry.text, similarity: overlap };
        }
      }
    }
    if (best.similarity >= threshold) {
      return { isDuplicate: true, ...best, reason: 'similar', threshold };
    }
    if (bestTarget.similarity >= targetOverlapThreshold) {
      return {
        isDuplicate: true, ...bestTarget, reason: 'same-target', threshold: targetOverlapThreshold,
      };
    }
    return { isDuplicate: false, ...best, reason: '', threshold };
  }

  // 들어온 해설을 막을 수 있는 분류(blocking-policy 표) 중 가장 최근에 내보낸 해설과의 간격을 잰다.
  // 표에 없는 분류(순위가 더 낮은 해설·질문 답)는 아무리 최근이어도 세지 않는다.
  function findRateLimited({ narrationClass = null, ts = Date.now(), hasPointingRegion = false }) {
    const rule = findBlockingRule({ narrationClass });
    if (!rule) return { isRateLimited: false, sinceMs: Infinity, minIntervalMs: 0, blockedByClass: null };
    const minIntervalMs = resolveMinIntervalMs({ rule, hasPointingRegion });
    let blocker = null;
    for (const entry of entryList) {
      if (!rule.blockedByClassList.includes(entry.narrationClass)) continue;
      if (!blocker || entry.ts > blocker.ts) blocker = entry;
    }
    const sinceMs = blocker ? ts - blocker.ts : Infinity;
    return {
      isRateLimited: sinceMs < minIntervalMs, sinceMs, minIntervalMs,
      blockedByClass: blocker ? blocker.narrationClass : null,
    };
  }

  function remember({ text, source = '', ts = Date.now(), slotMap = null, slideLabel = null,
    narrationClass = null }) {
    const normalized = normalizeNarration({ text });
    if (!normalized) return;
    entryList.push({
      text, normalized, source, ts, slideLabel, targetTokenSet: buildTargetTokenSet({ slotMap }),
      narrationClass: normalizeNarrationClass({ narrationClass }),
    });
    while (entryList.length > maxEntry) entryList.shift();
  }

  // 렌더러가 재생하지 않고 버린 해설. 듣지 못한 해설이 같은 대상의 다음 해설을 중복으로 막지 않게 지운다.
  function forget({ ts, text }) {
    const beforeCount = entryList.length;
    entryList = entryList.filter((entry) => !(entry.ts === ts && entry.text === text));
    return entryList.length < beforeCount;
  }

  function reset() {
    entryList = [];
  }

  function getEntryList() {
    return entryList.map(({ text, source, ts, narrationClass }) => ({ text, source, ts, narrationClass }));
  }

  function getRecentTextList({ limit = 4 } = {}) {
    return entryList.slice(-limit).map((entry) => entry.text);
  }

  return { findDuplicate, findRateLimited, remember, forget, reset, getEntryList, getRecentTextList };
}

module.exports = {
  createNarrationHistory, normalizeNarration, computeBigramSimilarity,
  DEFAULT_SIMILARITY_THRESHOLD, PAGE_TRANSITION_SIMILARITY_THRESHOLD,
  TARGET_OVERLAP_THRESHOLD,
};
