const DEFAULT_SIMILARITY_THRESHOLD = 0.58;
const PAGE_TRANSITION_SIMILARITY_THRESHOLD = 0.70;
const PAGE_TRANSITION_SOURCE = 'page-transition';
const DEFAULT_MAX_ENTRY = 400;

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
  maxEntry = DEFAULT_MAX_ENTRY,
} = {}) {
  let entryList = [];

  function resolveThreshold({ source }) {
    return source === PAGE_TRANSITION_SOURCE ? pageTransitionThreshold : similarityThreshold;
  }

  function findDuplicate({ text, source = '' }) {
    const threshold = resolveThreshold({ source });
    const normalized = normalizeNarration({ text });
    if (!normalized) {
      return { isDuplicate: false, matchedText: '', similarity: 0, reason: '', threshold };
    }
    let best = { matchedText: '', similarity: 0 };
    for (const entry of entryList) {
      if (entry.normalized === normalized) {
        return {
          isDuplicate: true, matchedText: entry.text, similarity: 1, reason: 'exact', threshold,
        };
      }
      const similarity = computeBigramSimilarity({ textA: normalized, textB: entry.normalized });
      if (similarity > best.similarity) best = { matchedText: entry.text, similarity };
    }
    if (best.similarity >= threshold) {
      return { isDuplicate: true, ...best, reason: 'similar', threshold };
    }
    return { isDuplicate: false, ...best, reason: '', threshold };
  }

  function remember({ text, source = '', ts = Date.now() }) {
    const normalized = normalizeNarration({ text });
    if (!normalized) return;
    entryList.push({ text, normalized, source, ts });
    while (entryList.length > maxEntry) entryList.shift();
  }

  function reset() {
    entryList = [];
  }

  function getEntryList() {
    return entryList.map(({ text, source, ts }) => ({ text, source, ts }));
  }

  function getRecentTextList({ limit = 8 } = {}) {
    return entryList.slice(-limit).map((entry) => entry.text);
  }

  return { findDuplicate, remember, reset, getEntryList, getRecentTextList };
}

module.exports = {
  createNarrationHistory, normalizeNarration, computeBigramSimilarity,
  DEFAULT_SIMILARITY_THRESHOLD, PAGE_TRANSITION_SIMILARITY_THRESHOLD,
};
