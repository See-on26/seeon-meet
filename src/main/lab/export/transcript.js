const { formatMediaClock } = require('./clock-format');

const roundOrNull = (value) => (Number.isFinite(value) ? Math.round(value) : null);

const pickDetectedLanguage = (source) => (typeof source.detectedLanguage === 'string' && source.detectedLanguage
  ? { detectedLanguage: source.detectedLanguage } : {});

// ASR 조각({ ts, endTs, text, segmentList, detectedLanguage? })을 원본 영상 시각의 발화 목록으로 바꾼다.
// segmentList 의 startSec·endSec 는 조각 시작(ts, 벽시계) 기준이다. 서버가 고른 언어가 있으면 그 조각의 발화마다 붙인다.
function buildTranscriptUtteranceList({ asrEventList, toMediaMs }) {
  const utteranceList = [];
  for (const event of asrEventList) {
    if (!Number.isFinite(event.ts)) continue;
    const languageField = pickDetectedLanguage(event);
    const segmentList = (event.segmentList || [])
      .filter((segment) => String(segment?.text || '').trim() && Number.isFinite(Number(segment.startSec)));
    if (segmentList.length) {
      for (const segment of segmentList) {
        const endSec = Number.isFinite(Number(segment.endSec)) ? Number(segment.endSec) : Number(segment.startSec);
        utteranceList.push({
          startMs: roundOrNull(toMediaMs(event.ts + Number(segment.startSec) * 1000)),
          endMs: roundOrNull(toMediaMs(event.ts + endSec * 1000)),
          text: String(segment.text).trim(),
          ...languageField,
        });
      }
    } else if (String(event.text || '').trim()) {
      utteranceList.push({
        startMs: roundOrNull(toMediaMs(event.ts)),
        endMs: roundOrNull(toMediaMs(Number.isFinite(event.endTs) ? event.endTs : event.ts)),
        text: String(event.text).trim(),
        ...languageField,
      });
    }
  }
  return utteranceList
    .filter((utterance) => utterance.startMs !== null)
    .sort((utteranceA, utteranceB) => utteranceA.startMs - utteranceB.startMs);
}

function buildTranscriptText({ utteranceList }) {
  return utteranceList.map((utterance) => `[${formatMediaClock(utterance.startMs)}] ${utterance.text}`).join('\n');
}

// pipeline-event 를 하나도 못 받았을 때 세션 jsonl 의 asr 레코드로 대신한다. 환각으로 막힌 조각은 뺀다.
function toAsrEventListFromRecordList(recordList) {
  return recordList
    .filter((record) => record.kind === 'asr' && !record.skipReason && String(record.text || '').trim())
    .map((record) => ({
      ts: record.ts, endTs: null, text: record.text, segmentList: record.segmentList || [], ...pickDetectedLanguage(record),
    }));
}

module.exports = { buildTranscriptUtteranceList, buildTranscriptText, toAsrEventListFromRecordList };
