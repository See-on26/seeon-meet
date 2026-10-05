const { formatMediaClock } = require('./clock-format');

const AD_LINE_LABEL = '(화면 해설)';

// 겹침 마스킹 규칙은 회의록 앞 장에 정의돼 있어 팀 확인이 필요하다. 지금은 해설과 겹친 발화 글을 이 표시로 바꾼다.
// 교차 모드의 자동 해설은 회의를 멈추고 트므로 겹치는 발화가 거의 없다(질문 답만 겹친다).
const OVERLAP_MASK_TEXT = '[해설과 겹침]';

const isRangeOverlap = (rangeA, rangeB) => rangeA.startMs < rangeB.endMs && rangeB.startMs < rangeA.endMs;

// 전사와 AD 를 시간순으로 합친다. AD 는 들린 자리(playedMediaMs, 없으면 사건 시각)에 끼운다.
// 같은 시각이면 발화를 먼저 둔다.
function buildMergedTimelineText({ utteranceList, adList, isOverlapMasked = false }) {
  const maskRangeList = isOverlapMasked
    ? adList.map((ad) => ad.heardMediaRange).filter((range) => range && range.endMs > range.startMs) : [];
  const entryList = [
    ...utteranceList.map((utterance, index) => ({
      kind: 0, ms: utterance.startMs, order: index,
      text: maskRangeList.some((range) => isRangeOverlap(range, utterance)) ? OVERLAP_MASK_TEXT : utterance.text,
    })),
    ...adList.map((ad, index) => ({
      kind: 1, ms: Number.isFinite(ad.playedMediaMs) ? ad.playedMediaMs : ad.eventMediaMs, order: index,
      text: `${AD_LINE_LABEL} ${ad.text}`,
    })),
  ].filter((entry) => Number.isFinite(entry.ms));
  entryList.sort((entryA, entryB) => entryA.ms - entryB.ms || entryA.kind - entryB.kind || entryA.order - entryB.order);
  return entryList.map((entry) => `[${formatMediaClock(entry.ms)}] ${entry.text}`).join('\n');
}

module.exports = { buildMergedTimelineText, AD_LINE_LABEL, OVERLAP_MASK_TEXT };
