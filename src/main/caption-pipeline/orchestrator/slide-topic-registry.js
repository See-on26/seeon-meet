const { computeBigramSimilarity } = require('./narration-history');

const DEFAULT_TOPIC_MATCH_THRESHOLD = 0.9;

const DEFAULT_DESCRIPTION_MATCH_THRESHOLD = 0.5;

const SLIDE_TOPIC_VERDICT_MAP = {
  same: 'same',
  revisit: 'revisit',
  fresh: 'fresh',
};

function createSlideTopicRegistry({
  matchThreshold = DEFAULT_TOPIC_MATCH_THRESHOLD,
  descriptionMatchThreshold = DEFAULT_DESCRIPTION_MATCH_THRESHOLD,
} = {}) {
  let entryList = [];
  let lastEntry = null;
  // 들려주는 "슬라이드 N" 순번. 문서·웹 같은 화면도 복귀 판단을 위해 기록하지만 이 순번은 슬라이드에만 준다.
  let slideCount = 0;

  const nextSlideOrder = () => {
    slideCount += 1;
    return slideCount;
  };

  function scoreEntry({ topic, description, entry }) {
    return {
      entry,
      topicSimilarity: computeBigramSimilarity({ textA: topic, textB: entry.topic }),
      descriptionSimilarity: computeBigramSimilarity({ textA: description, textB: entry.description }),
    };
  }

  function isMatch({ score }) {
    return score.topicSimilarity >= matchThreshold
      && score.descriptionSimilarity >= descriptionMatchThreshold;
  }

  function findNearest({ topic, description }) {
    let nearest = null;
    for (const entry of entryList) {
      const score = scoreEntry({ topic, description, entry });
      if (!nearest || score.topicSimilarity > nearest.topicSimilarity) nearest = score;
    }
    return nearest;
  }

  function buildVerdict({ kind, score }) {
    return {
      kind,
      matchedTopic: score?.entry.topic || '',
      similarity: score?.topicSimilarity || 0,
      descriptionSimilarity: score?.descriptionSimilarity || 0,
    };
  }

  function resolveDisplayNumber({ entry }) {
    return entry ? (entry.pageNumber || entry.order) : null;
  }

  function judge({ topic, description = '' }) {
    const trimmedTopic = String(topic || '').trim();
    if (!trimmedTopic || !entryList.length) {
      return buildVerdict({ kind: SLIDE_TOPIC_VERDICT_MAP.fresh, score: null });
    }
    const matchList = entryList
      .map((entry) => scoreEntry({ topic: trimmedTopic, description, entry }))
      .filter((score) => isMatch({ score }));
    if (!matchList.length) {
      return buildVerdict({
        kind: SLIDE_TOPIC_VERDICT_MAP.fresh,
        score: findNearest({ topic: trimmedTopic, description }),
      });
    }
    const best = matchList.reduce((a, b) => (b.topicSimilarity > a.topicSimilarity ? b : a));
    const isSameAsLast = Boolean(lastEntry) && isMatch({
      score: scoreEntry({ topic: trimmedTopic, description, entry: lastEntry }),
    });
    return buildVerdict({
      kind: isSameAsLast ? SLIDE_TOPIC_VERDICT_MAP.same : SLIDE_TOPIC_VERDICT_MAP.revisit,
      score: best,
    });
  }

  // 주제를 못 읽은 슬라이드는 복귀를 알아볼 수 없어 기록하지 않지만, 번호는 슬라이드 순번에서 받는다.
  function remember({ topic, description = '', pageNumber = null, isSlide = false }) {
    const trimmedTopic = String(topic || '').trim();
    if (!trimmedTopic) {
      return isSlide ? { topic: '', description: String(description || ''), order: nextSlideOrder(), pageNumber: pageNumber || null } : null;
    }
    const nearest = findNearest({ topic: trimmedTopic, description });
    if (nearest && isMatch({ score: nearest })) {
      lastEntry = nearest.entry;
      if (!nearest.entry.pageNumber && pageNumber) nearest.entry.pageNumber = pageNumber;
      if (isSlide && nearest.entry.order === null) nearest.entry.order = nextSlideOrder();
      return nearest.entry;
    }
    const entry = {
      topic: trimmedTopic,
      description: String(description || ''),
      order: isSlide ? nextSlideOrder() : null,
      pageNumber: pageNumber || null,
    };
    entryList.push(entry);
    lastEntry = entry;
    return entry;
  }

  function reset() {
    entryList = [];
    lastEntry = null;
    slideCount = 0;
  }

  return { judge, remember, resolveDisplayNumber, reset };
}

module.exports = {
  createSlideTopicRegistry, SLIDE_TOPIC_VERDICT_MAP,
  DEFAULT_TOPIC_MATCH_THRESHOLD, DEFAULT_DESCRIPTION_MATCH_THRESHOLD,
};
