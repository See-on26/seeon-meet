const { resolvePlayedWallMs } = require('../time-map');
const { isCrossMode } = require('../lab-mode');

// 회의록 AD 분류 표기(viewer 로그 카드와 같다).
const AID_MAP = {
  page_transition: 'A1',
  deixis: 'A2',
  interpretation: 'A3',
  visual_description: 'A4',
  user_command: 'Q',
  speaker_identity: 'S',
};

// 페이지 전환 고지는 캡션 source 가 'page-transition' 으로 온다.
const LEGACY_TRANSITION_SOURCE = 'page-transition';
const USER_COMMAND_CLASS = 'user_command';

const DROP_REASON_MAP = {
  noAudio: 'no_audio',
  notPlayed: 'not_played',
  suppressed: 'suppressed',
};

const roundOrNull = (value) => (Number.isFinite(value) ? Math.round(value) : null);
const buildCaptionKey = ({ ts, text }) => `${ts}|${text}`;

function normalizeNarrationType(source) {
  return source === LEGACY_TRANSITION_SOURCE ? 'page_transition' : source || null;
}

function parseAnchorText(summary) {
  const match = /근거 표현=([^·]*)/.exec(summary || '');
  const text = match ? match[1].trim() : '';
  return text === '(없음)' ? '' : text;
}

// 해설이 들리는 동안 사용자가 듣던 회의 소리의 원본 구간. 교차 모드의 자동 해설은 회의를 멈추고 트므로 길이가 0 이다.
// 질문 답은 교차 모드에서도 회의를 멈추지 않는다.
function resolveHeardMediaRange({ playback, toMediaMs, durationMs }) {
  const playedWallMs = resolvePlayedWallMs(playback);
  if (!Number.isFinite(playedWallMs)) return null;
  const startMs = toMediaMs(playedWallMs);
  if (!Number.isFinite(startMs)) return null;
  const isMeetingPaused = isCrossMode(playback.mode) && playback.narrationClass !== USER_COMMAND_CLASS;
  if (isMeetingPaused || !(durationMs > 0)) return { startMs: Math.round(startMs), endMs: Math.round(startMs) };
  return { startMs: Math.round(startMs), endMs: Math.round(toMediaMs(playedWallMs + durationMs)) };
}

// 해설 구간과 겹친 발화 길이 합(원본 영상 시각, ms). 회의록 3.4.3 "방해" 축.
function computeOverlapSpeechMs({ utteranceList, range }) {
  if (!range || range.endMs <= range.startMs) return 0;
  return utteranceList.reduce((sum, utterance) => {
    const overlapMs = Math.min(utterance.endMs, range.endMs) - Math.max(utterance.startMs, range.startMs);
    return sum + Math.max(0, overlapMs);
  }, 0);
}

function buildAdTimeline({
  captionEventList, playbackList, deixisRecordList = [], narrationRecordList = [], rendererDropList = [],
  utteranceList = [], toMediaMs, captureStartWallMs, outputStartWallMs = null,
}) {
  const playbackMap = new Map();
  for (const playback of playbackList) {
    const key = buildCaptionKey(playback);
    if (!playbackMap.has(key)) playbackMap.set(key, playback);
  }
  const deixisMap = new Map(deixisRecordList
    .filter((record) => record.caption)
    .map((record) => [buildCaptionKey({ ts: record.ts, text: record.caption }), record]));
  const dropMap = new Map(rendererDropList.map((drop) => [buildCaptionKey(drop), drop]));
  const toEventMediaMs = (caption) => (Number.isFinite(caption.eventVideoTimeMs) && Number.isFinite(captureStartWallMs)
    ? toMediaMs(captureStartWallMs + caption.eventVideoTimeMs) : toMediaMs(caption.ts));

  const adList = [];
  const droppedList = [];
  for (const caption of captionEventList) {
    const key = buildCaptionKey(caption);
    const playback = playbackMap.get(key);
    const eventMediaMs = roundOrNull(toEventMediaMs(caption));
    const type = normalizeNarrationType(caption.source);
    if (!playback) {
      droppedList.push({
        text: caption.text, type, narrationClass: caption.narrationClass, slideLabel: caption.slideLabel ?? null, eventMediaMs,
        reason: dropMap.get(key)?.reason || (caption.hasAudio === false ? DROP_REASON_MAP.noAudio : DROP_REASON_MAP.notPlayed),
      });
      continue;
    }
    const durationMs = Number.isFinite(playback.durationMs) ? playback.durationMs : (caption.audioDurationMs ?? null);
    const playedWallMs = resolvePlayedWallMs(playback);
    const playedMediaMs = Number.isFinite(playedWallMs) ? roundOrNull(toMediaMs(playedWallMs)) : null;
    const heardMediaRange = resolveHeardMediaRange({ playback, toMediaMs, durationMs });
    const deixis = deixisMap.get(key) || null;
    adList.push({
      narrationClass: caption.narrationClass,
      type,
      aid: AID_MAP[type] || null,
      text: caption.text,
      eventMediaMs,
      playedMediaMs,
      outputMs: Number.isFinite(outputStartWallMs) ? Math.round(playback.wallMs - outputStartWallMs) : null,
      durationMs,
      slideLabel: caption.slideLabel ?? null,
      rationale: caption.rationale ?? null,
      trigger: {
        utterance: caption.rationale?.utterance || deixis?.utterance || null,
        anchor: parseAnchorText(caption.rationale?.summary) || null,
        judgeReason: deixis?.judgeReason ?? null,
      },
      latencyMs: Number.isFinite(playedMediaMs) && Number.isFinite(eventMediaMs) ? playedMediaMs - eventMediaMs : null,
      overlapSpeechMs: Math.round(computeOverlapSpeechMs({ utteranceList, range: heardMediaRange })),
      heardMediaRange,
      interruptedReason: dropMap.get(key)?.reason || null,
    });
  }
  for (const record of narrationRecordList) {
    if (record.isEmitted !== false) continue;
    droppedList.push({
      text: record.text, type: normalizeNarrationType(record.source), narrationClass: record.narrationClass || null,
      slideLabel: record.slideLabel ?? null, eventMediaMs: roundOrNull(toMediaMs(record.ts)),
      reason: record.skipReason || DROP_REASON_MAP.suppressed,
    });
  }
  const position = (ad) => (Number.isFinite(ad.playedMediaMs) ? ad.playedMediaMs : ad.eventMediaMs ?? 0);
  adList.sort((adA, adB) => position(adA) - position(adB));
  adList.forEach((ad, index) => { ad.id = `ad-${String(index + 1).padStart(3, '0')}`; });
  droppedList.sort((dropA, dropB) => (dropA.eventMediaMs ?? 0) - (dropB.eventMediaMs ?? 0));
  return { adList: adList.map(({ id, ...rest }) => ({ id, ...rest })), droppedList };
}

function median(valueList) {
  const sortedList = [...valueList].sort((valueA, valueB) => valueA - valueB);
  const middle = sortedList.length >> 1;
  return sortedList.length % 2 ? sortedList[middle] : (sortedList[middle - 1] + sortedList[middle]) / 2;
}

// 회의록 3.4.3: 방해(겹친 발화 길이)와 지연(사건부터 들린 순간까지)을 두 축으로 따로 본다.
function summarizeAdTiming({ adList }) {
  const latencyList = adList.map((ad) => ad.latencyMs).filter(Number.isFinite);
  return {
    adCount: adList.length,
    latencyMeanMs: latencyList.length ? Math.round(latencyList.reduce((sum, value) => sum + value, 0) / latencyList.length) : null,
    latencyMedianMs: latencyList.length ? Math.round(median(latencyList)) : null,
    overlapSpeechTotalMs: adList.reduce((sum, ad) => sum + (ad.overlapSpeechMs || 0), 0),
    overlapAdCount: adList.filter((ad) => ad.overlapSpeechMs > 0).length,
  };
}

module.exports = {
  buildAdTimeline, summarizeAdTiming, computeOverlapSpeechMs, resolveHeardMediaRange, parseAnchorText,
  AID_MAP, DROP_REASON_MAP,
};
