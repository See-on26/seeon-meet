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
  // Whisper 가 무음·잡음 조각에서 내는 대표 영어 문구. 문장 전부가 목록에 있을 때만 버리므로
  // "Thank you for the update." 처럼 다른 말이 붙은 발화는 지우지 않는다.
  'Thank you.',
  'Thanks for watching!',
  'Thank you for watching.',
  'Thank you so much for watching.',
  'Please subscribe.',
  'Please subscribe to my channel.',
  'Subtitles by the Amara.org community',
  'you',
];

const TRAILING_MARK_PATTERN = /[\s.,!?~…"'’”)\]]+$/;

function normalizeForCompare({ text }) {
  return String(text || '').trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(TRAILING_MARK_PATTERN, '');
}

function toSentenceList({ text }) {
  return String(text || '').split(/[.!?…]+/)
    .map((sentence) => normalizeForCompare({ text: sentence }))
    .filter(Boolean);
}

// 전사문과 같은 방식으로 문장을 나눠 담는다. "Amara.org" 처럼 문구 안에 마침표가 있어도 맞춰 볼 수 있다.
const HALLUCINATION_TEXT_SET = new Set(
  HALLUCINATION_TEXT_LIST.flatMap((text) => toSentenceList({ text })),
);

function isHallucinatedTranscript({ text }) {
  const sentenceList = toSentenceList({ text });
  if (!sentenceList.length) return false;
  return sentenceList.every((sentence) => HALLUCINATION_TEXT_SET.has(sentence));
}

function createAsrClient({ config }) {
  // language 를 주지 않으면 쿼리에서 빼서 서버 기본(ko)을 따른다.
  async function transcribeSegment({ webmBuffer, startTs, language }) {
    const languageQuery = language ? `&language=${encodeURIComponent(language)}` : '';
    const response = await fetch(`${config.asrUrl}?startTs=${startTs}${languageQuery}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: webmBuffer,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`ASR HTTP ${response.status}`);
    const body = await response.json();
    if (typeof body.text !== 'string') throw new Error('ASR 응답에 text 없음');
    const segmentList = Array.isArray(body.segmentList) ? body.segmentList : [];
    // 실제 전사에 쓴 언어와 auto 감지 확률. 언어를 돌려주지 않는 옛 서버면 null.
    const languageInfo = {
      language: typeof body.language === 'string' ? body.language : null,
      languageProbability: typeof body.languageProbability === 'number' ? body.languageProbability : null,
    };
    if (isHallucinatedTranscript({ text: body.text })) {
      return { text: '', segmentList: [], hallucinationText: body.text.trim(), ...languageInfo };
    }
    return { text: body.text, segmentList, hallucinationText: '', ...languageInfo };
  }
  return { transcribeSegment };
}

module.exports = { createAsrClient, isHallucinatedTranscript, HALLUCINATION_TEXT_LIST };
