const { formatMediaClock } = require('./clock-format');
// ASR 조각을 원본 영상 시각의 발화 목록으로 바꾸는 일은 제품 개발자 흐름 창과 같은 공용 모듈을 쓴다.
const { buildTranscriptUtteranceList } = require('../../dev-flow/transcript-utterance');

const pickDetectedLanguage = (source) => (typeof source.detectedLanguage === 'string' && source.detectedLanguage
  ? { detectedLanguage: source.detectedLanguage } : {});

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
