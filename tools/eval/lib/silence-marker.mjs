// 전사 안의 무발화 표시. "[무발화 7초]" 처럼 길이를 초 단위로 적는다.
const SILENCE_MARKER_PATTERN = /\[무발화\s*(\d+(?:\.\d+)?)\s*초\]/g;

export function listSilenceMarker(text) {
  const markerList = [];
  for (const match of String(text || '').matchAll(SILENCE_MARKER_PATTERN)) {
    markerList.push({
      start: match.index,
      end: match.index + match[0].length,
      trigger: match[0],
      silenceMs: Math.round(Number(match[1]) * 1000),
    });
  }
  return markerList;
}
