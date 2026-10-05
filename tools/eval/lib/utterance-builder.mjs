import { listSilenceMarker } from './silence-marker.mjs';

// mode-policy.js 의 TTS 어절 추정(어절당 450ms)과 같은 값이다. 같은 값인지는 테스트가 확인한다.
export const SPEECH_MS_PER_WORD = 450;

export const PIECE_KIND_MAP = { speech: 'speech', silence: 'silence' };

const SENTENCE_END_PATTERN = /[.?!…]+(?=\s|$)/g;

export function countWord(text) {
  return (String(text).trim().match(/\S+/g) || []).length;
}

function pushTrimmedSpeech({ transcript, from, to, pieceList }) {
  const raw = transcript.slice(from, to);
  const start = from + (raw.length - raw.trimStart().length);
  const end = to - (raw.length - raw.trimEnd().length);
  if (end > start) pieceList.push({ kind: PIECE_KIND_MAP.speech, start, end, text: transcript.slice(start, end) });
}

function pushSentenceList({ transcript, from, to, pieceList }) {
  const segment = transcript.slice(from, to);
  let sentenceStart = 0;
  for (const match of segment.matchAll(SENTENCE_END_PATTERN)) {
    const sentenceEnd = match.index + match[0].length;
    pushTrimmedSpeech({ transcript, from: from + sentenceStart, to: from + sentenceEnd, pieceList });
    sentenceStart = sentenceEnd;
  }
  pushTrimmedSpeech({ transcript, from: from + sentenceStart, to, pieceList });
}

// 전사를 문장 단위 발화와 무발화 구간으로 나눈다. start·end 는 전사 원문 기준 글자 위치다.
export function splitTranscript({ transcript }) {
  const pieceList = [];
  let cursor = 0;
  for (const marker of listSilenceMarker(transcript)) {
    pushSentenceList({ transcript, from: cursor, to: marker.start, pieceList });
    pieceList.push({
      kind: PIECE_KIND_MAP.silence, start: marker.start, end: marker.end, text: marker.trigger, silenceMs: marker.silenceMs,
    });
    cursor = marker.end;
  }
  pushSentenceList({ transcript, from: cursor, to: transcript.length, pieceList });
  return pieceList;
}

// 시각이 없는 전사는 어절당 0.45초로 말한다고 보고, 무발화 표시는 그 길이만큼 시계를 민다.
export function estimateTiming({ pieceList }) {
  let clockMs = 0;
  return pieceList.map((piece) => {
    const durationMs = piece.kind === PIECE_KIND_MAP.silence
      ? piece.silenceMs : countWord(piece.text) * SPEECH_MS_PER_WORD;
    const timed = { ...piece, startMs: clockMs, endMs: clockMs + durationMs };
    clockMs += durationMs;
    return timed;
  });
}

// 항목에 utteranceList 가 있으면 그 시각을 쓴다. 무발화 표시는 바로 앞 발화가 끝난 시각부터 그 길이만큼 둔다.
function buildFromGivenUtteranceList({ item }) {
  const pieceList = [];
  let cursor = 0;
  for (const utterance of item.utteranceList) {
    const start = item.transcript.indexOf(utterance.text, cursor);
    if (start < 0) throw new Error(`[${item.id}] 전사에서 발화 "${utterance.text}" 를 찾지 못했다`);
    pieceList.push({
      kind: PIECE_KIND_MAP.speech, start, end: start + utterance.text.length, text: utterance.text,
      startMs: utterance.startMs, endMs: utterance.endMs,
    });
    cursor = start + utterance.text.length;
  }
  for (const marker of listSilenceMarker(item.transcript)) {
    const previous = pieceList.filter((piece) => piece.kind === PIECE_KIND_MAP.speech && piece.end <= marker.start).at(-1);
    const startMs = previous ? previous.endMs : 0;
    pieceList.push({
      kind: PIECE_KIND_MAP.silence, start: marker.start, end: marker.end, text: marker.trigger,
      silenceMs: marker.silenceMs, startMs, endMs: startMs + marker.silenceMs,
    });
  }
  return pieceList.sort((pieceA, pieceB) => pieceA.start - pieceB.start);
}

export function buildUtteranceList({ item }) {
  const pieceList = Array.isArray(item.utteranceList) && item.utteranceList.length
    ? buildFromGivenUtteranceList({ item })
    : estimateTiming({ pieceList: splitTranscript({ transcript: item.transcript }) });
  return pieceList.map((piece, index) => ({ ...piece, index }));
}

// 글자 위치가 든 발화. 발화 사이 공백이면 바로 앞 발화로 본다.
export function findPieceIndexByOffset({ utteranceList, offset }) {
  const containing = utteranceList.find((piece) => piece.start <= offset && offset < piece.end);
  if (containing) return containing.index;
  const previous = utteranceList.filter((piece) => piece.start <= offset).at(-1);
  return previous ? previous.index : -1;
}
