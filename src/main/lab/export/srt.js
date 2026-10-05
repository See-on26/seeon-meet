const { formatSrtTime } = require('./clock-format');

const DEFAULT_CUE_MS = 4000;
const MIN_CUE_MS = 500;

// AD 자막. 들린 자리(playedMediaMs, 없으면 사건 시각)에서 해설 길이만큼 띄우고 다음 자막과 겹치지 않게 자른다.
function buildAdSrt({ adList }) {
  const cueList = adList
    .map((ad) => ({
      startMs: Number.isFinite(ad.playedMediaMs) ? ad.playedMediaMs : ad.eventMediaMs,
      durationMs: ad.durationMs > 0 ? ad.durationMs : DEFAULT_CUE_MS,
      text: ad.text,
    }))
    .filter((cue) => Number.isFinite(cue.startMs))
    .sort((cueA, cueB) => cueA.startMs - cueB.startMs);
  return cueList.map((cue, index) => {
    const next = cueList[index + 1];
    const naturalEndMs = cue.startMs + cue.durationMs;
    const endMs = next ? Math.max(cue.startMs + MIN_CUE_MS, Math.min(naturalEndMs, next.startMs - 1)) : naturalEndMs;
    return `${index + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(endMs)}\n${cue.text}\n`;
  }).join('\n');
}

module.exports = { buildAdSrt };
