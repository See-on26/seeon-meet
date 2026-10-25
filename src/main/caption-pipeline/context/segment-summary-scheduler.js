const { listSegments, DEFAULT_MAX_SEGMENT_MS } = require('./segment-plan');
const { buildSegmentMaterial, hasSegmentContent } = require('./segment-material');
const { SEGMENT_STATUS_MAP } = require('./context-store');

// 구간이 닫힌 뒤 이만큼 기다렸다 요약한다. 늦게 도착한 받아쓰기·해설 기록이 그 구간 재료에 들어오게 한다.
const DEFAULT_SETTLE_MS = 5000;

// 회의 중 닫힌 구간을 하나씩 요약해 맥락 Store 에 쌓는다. 요청은 GPU 배경 순위라 실시간 해설 요청이 없을 때만 나간다.
// 새 세션(reset)이나 회의 끝(stop) 전에 보낸 요청의 응답은 버린다 — 새 세션에도 같은 key 가 생길 수 있고,
// 회의 뒤 생성기는 스냅숏에서 ready 가 아닌 구간을 다시 만든다.
function createSegmentSummaryScheduler({
  contextStore, segmentSummaryAgent, getCaptionLanguage, isEnabled = () => true,
  now = Date.now, settleMs = DEFAULT_SETTLE_MS, maxSegmentMs = DEFAULT_MAX_SEGMENT_MS,
}) {
  let generation = 0;
  let isStopped = false;
  let isSummarizing = false;
  let pendingSegmentList = [];

  // 재료는 보내기 직전의 스냅숏으로 만든다. 줄에서 기다리는 동안 도착한 기록도 들어간다.
  // 재료가 없는 구간은 GPU 에 묻지 않고 빈 구간으로 둔다.
  async function summarizeSegment({ segment, requestGeneration }) {
    const startedAt = now();
    try {
      const snapshot = contextStore.snapshot();
      if (!hasSegmentContent({ snapshot, segment })) {
        contextStore.setSegmentSummary({ key: segment.key, text: '', status: SEGMENT_STATUS_MAP.ready });
        console.log(`[summary] 구간 요약 ${segment.key} — 재료 없음(묻지 않음)`);
        return;
      }
      const materialText = buildSegmentMaterial({ snapshot, segment });
      const { text } = await segmentSummaryAgent.summarize({ materialText, language: getCaptionLanguage() });
      if (requestGeneration !== generation) return;
      contextStore.setSegmentSummary({ key: segment.key, text, status: SEGMENT_STATUS_MAP.ready });
      console.log(`[summary] 구간 요약 ${segment.key} — ${text ? `${text.length}자` : '빈 구간'} (${now() - startedAt}ms)`);
    } catch (error) {
      if (requestGeneration !== generation) return;
      contextStore.setSegmentSummary({ key: segment.key, status: SEGMENT_STATUS_MAP.failed });
      console.warn(`[summary] 구간 요약 ${segment.key} 실패 — 회의 뒤에 다시 만든다: ${error?.message}`);
    }
  }

  // 한 번에 하나만 보낸다. 앞 세대의 요청이 아직 돌고 있으면 그것이 끝난 뒤 새 세대의 줄을 잇는다.
  // 회의 중에 꺼지면 돌고 있는 요청만 마치고, 줄의 나머지는 다시 켜진 뒤의 poll 에서 잇는다.
  function runNext() {
    if (isSummarizing || !pendingSegmentList.length || !isEnabled()) return;
    const segment = pendingSegmentList.shift();
    isSummarizing = true;
    // 실패 기록마저 쓰지 못한 오류도 거부로 새지 않게 여기서 받는다. 그 구간은 회의 뒤 생성기가 다시 만든다.
    summarizeSegment({ segment, requestGeneration: generation })
      .catch((error) => console.warn(`[summary] 구간 요약 ${segment.key} 처리 오류(무시): ${error?.message}`))
      .finally(() => {
        isSummarizing = false;
        runNext();
      });
  }

  // 지금 보는 화면의 구간(isOpenTail)은 아직 닫히지 않아 넣지 않는다. 한 번 요청한 구간은 실패해도 회의 중에 다시 넣지 않는다.
  function poll() {
    if (isStopped || !isEnabled()) return;
    const nowTs = now();
    const snapshot = contextStore.snapshot();
    const knownKeySet = new Set(snapshot.segmentSummaryList.map((segmentSummary) => segmentSummary.key));
    const settledList = listSegments({ snapshot, endTs: nowTs, maxSegmentMs })
      .filter((segment) => !segment.isOpenTail && segment.endTs <= nowTs - settleMs && !knownKeySet.has(segment.key));
    for (const segment of settledList) {
      const { key, slideMajor, startTs, endTs, isRevisit } = segment;
      contextStore.markSegmentRequested({ key, slideMajor, startTs, endTs, isRevisit });
      pendingSegmentList.push(segment);
    }
    runNext();
  }

  function reset() {
    generation += 1;
    pendingSegmentList = [];
    isStopped = false;
  }

  function stop() {
    generation += 1;
    pendingSegmentList = [];
    isStopped = true;
  }

  return { poll, reset, stop };
}

module.exports = { createSegmentSummaryScheduler };
