const REQUEST_TIMEOUT_MS = 20000;

const HALLUCINATION_TEXT_LIST = [
  '감사합니다',
  '한글자막 by 한효정',
  '시청해주셔서 감사합니다',
  '시청해 주셔서 감사합니다',
  '구독과 좋아요 부탁드립니다',
  '구독과 좋아요',
  '다음 영상에서 만나요',
  'mbc 뉴스 이덕영입니다',
];

const TRAILING_MARK_PATTERN = /[\s.,!?~…"'’”)\]]+$/;

function normalizeForCompare({ text }) {
  return String(text || '').trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(TRAILING_MARK_PATTERN, '');
}

const HALLUCINATION_TEXT_SET = new Set(
  HALLUCINATION_TEXT_LIST.map((text) => normalizeForCompare({ text })),
);

function isHallucinatedTranscript({ text }) {
  const sentenceList = String(text || '').split(/[.!?…]+/)
    .map((sentence) => normalizeForCompare({ text: sentence }))
    .filter(Boolean);
  if (!sentenceList.length) return false;
  return sentenceList.every((sentence) => HALLUCINATION_TEXT_SET.has(sentence));
}

function createAsrClient({ config }) {
  async function transcribeSegment({ webmBuffer, startTs }) {
    const response = await fetch(`${config.asrUrl}?startTs=${startTs}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: webmBuffer,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`ASR HTTP ${response.status}`);
    const body = await response.json();
    if (typeof body.text !== 'string') throw new Error('ASR 응답에 text 없음');
    const segmentList = Array.isArray(body.segmentList) ? body.segmentList : [];
    if (isHallucinatedTranscript({ text: body.text })) {
      return { text: '', segmentList: [], hallucinationText: body.text.trim() };
    }
    return { text: body.text, segmentList, hallucinationText: '' };
  }
  return { transcribeSegment };
}

module.exports = { createAsrClient, isHallucinatedTranscript, HALLUCINATION_TEXT_LIST };
