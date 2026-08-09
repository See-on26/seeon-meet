const { computeBigramSimilarity } = require('./narration-history');

// 이 검사는 "같은 슬라이드인가"를 가리는 주 판정이 아니라 **명백한 중복만 걷어내는 안전망**이다.
// 실측(2026-08-09 실회의)에서 같은 섹션의 다른 슬라이드는 제목이 통째로 같고(유사도 1.000)
// 묘사도 긴 구절을 공유해 0.304까지 나왔다. 느슨하게 잡으면 멀쩡한 슬라이드를 삼킨다.
// 놓친 고지는 중복 고지보다 나쁘다 — 청자는 그 화면이 있었다는 사실조차 모른다.
// 그래서 두 값이 모두 "거의 같은 글자"일 때만 억제한다.
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
    // 직전에 확정한 것과 같으면 화면이 안 바뀐 것이다 — 필기·애니메이션으로 후보만 다시 뜬
    // 경우라 고지하지 않는다. 더 오래된 것과 같으면 되돌아온 것이므로 축약 고지 대상이다
    const isSameAsLast = Boolean(lastEntry) && isMatch({
      score: scoreEntry({ topic: trimmedTopic, description, entry: lastEntry }),
    });
    return buildVerdict({
      kind: isSameAsLast ? SLIDE_TOPIC_VERDICT_MAP.same : SLIDE_TOPIC_VERDICT_MAP.revisit,
      score: best,
    });
  }

  function remember({ topic, description = '', label = '' }) {
    const trimmedTopic = String(topic || '').trim();
    if (!trimmedTopic) return;
    const entry = { topic: trimmedTopic, description: String(description || ''), label: String(label || '') };
    const nearest = findNearest({ topic: trimmedTopic, description });
    lastEntry = entry;
    if (nearest && isMatch({ score: nearest })) return;
    entryList.push(entry);
  }

  function reset() {
    entryList = [];
    lastEntry = null;
  }

  return { judge, remember, reset };
}

module.exports = {
  createSlideTopicRegistry, SLIDE_TOPIC_VERDICT_MAP,
  DEFAULT_TOPIC_MATCH_THRESHOLD, DEFAULT_DESCRIPTION_MATCH_THRESHOLD,
};
