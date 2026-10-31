// 레이저·펜 영역은 움직이는 순간 대기 중인 발화 후보에만 붙는다. 그런데 "여기"가 든 문장은 ASR 조각이 끝나야 도착하므로,
// 말하면서 가리키면 그 사이 영역이 버려지고 지시 해설이 화면 전체를 보고 엉뚱한 대상을 고른다.
// 최근에 잡힌 영역을 슬라이드와 함께 잠시 기억했다가, 직전 창에 영역이 없는 지시 발화에 붙인다.
export const POINTING_MEMORY_KEEP_MS = 10000;
// 트리거가 든 전사 구간 끝에서 이만큼 앞까지 가리킨 것을 그 발화의 가리킴으로 본다(조각 길이 + 말보다 먼저 가리키는 몫).
export const POINTING_RECALL_LOOKBACK_MS = 6000;

export function createRecentPointingMemory({ keepMs = POINTING_MEMORY_KEEP_MS, lookbackMs = POINTING_RECALL_LOOKBACK_MS } = {}) {
  let entryList = [];

  function remember({ region, pointingOrderHint = '', wallTs, slideLabel = null }) {
    if (!region || !Number.isFinite(wallTs)) return;
    entryList = [
      ...entryList.filter((entry) => wallTs - entry.wallTs <= keepMs),
      { region, pointingOrderHint, wallTs, slideLabel },
    ];
  }

  // eventWallTs: 트리거가 든 전사 구간이 끝난 벽시계 시각.
  function recall({ eventWallTs, slideLabel = null }) {
    if (!Number.isFinite(eventWallTs)) return null;
    const sinceWallTs = eventWallTs - lookbackMs;
    const found = [...entryList].reverse()
      .find((entry) => entry.wallTs >= sinceWallTs && entry.slideLabel === slideLabel);
    return found ? { region: found.region, pointingOrderHint: found.pointingOrderHint } : null;
  }

  return { remember, recall, reset: () => { entryList = []; } };
}
