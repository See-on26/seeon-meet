const { normalizeKoreanSpeechText } = require('./korean-speech-text');

const REQUEST_TIMEOUT_MS = 15000;

const LONG_REQUEST_TIMEOUT_MS = 600000;

// 캡션 언어 → TTS 서버 언어 코드(tools/gpu-server/tts_server.py). 서버는 모르는 값이면 한국어로 읽는다.
const TTS_LANGUAGE_MAP = { ko: 'KR', en: 'EN' };
const DEFAULT_TTS_LANGUAGE = TTS_LANGUAGE_MAP.ko;

// MeloTTS 가 읽지 못하는 기호를 말로 바꾼다. 영어 목소리는 영어 낱말로 읽어야 하므로 언어마다 따로 둔다.
const SPEECH_SYMBOL_MAP = {
  ko: { symbolMap: { '&': '앤드', '=': '는' }, currencySuffix: '달러' },
  en: { symbolMap: { '&': ' and ', '=': ' equals ' }, currencySuffix: ' dollars' },
};

const LEADING_CURRENCY_PATTERN = /\$\s*([\d,.]+)/g;

const UNSPEAKABLE_SYMBOL_PATTERN = /[&<>$@|`{}=+]/g;

function sanitizeForSpeech({ text, language = 'ko' }) {
  const { symbolMap, currencySuffix } = SPEECH_SYMBOL_MAP[language] || SPEECH_SYMBOL_MAP.ko;
  return String(text || '')
    .replace(LEADING_CURRENCY_PATTERN, `$1${currencySuffix}`)
    .replace(UNSPEAKABLE_SYMBOL_PATTERN, (symbol) => symbolMap[symbol] || ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeMultilineForSpeech({ text, language = 'ko' }) {
  return String(text || '')
    .split('\n')
    .map((line) => sanitizeForSpeech({ text: line, language }))
    .join('\n');
}

// 서버로 보낼 읽기 글. 한국어는 숫자·세는 말·단위를 읽는 말로 바꿔 음성 엔진이 달라도 같은 글을 받게 한다.
// sanitizeForSpeech 는 기호만 바꾸는 공용 정리라 그 안에 넣지 않는다(영어·기호 읽기 결과를 바꾸지 않는다).
function toSpeechText({ text, language }) {
  const sanitized = sanitizeForSpeech({ text, language });
  return language === 'ko' ? normalizeKoreanSpeechText(sanitized) : sanitized;
}

function toMultilineSpeechText({ text, language }) {
  return String(text || '')
    .split('\n')
    .map((line) => toSpeechText({ text: line, language }))
    .join('\n');
}

function createTtsClient({ config }) {
  // language 는 캡션 언어(ko·en)다. 서버에는 언어 코드(KR·EN)로 보낸다.
  // speed 는 세션 읽기 속도(MeloTTS speed)다. 없으면 보내지 않아 서버 기본 속도(2.0)로 읽는다.
  async function synthesize({ text, language = 'ko', speed }) {
    const body = { text: toSpeechText({ text, language }), language: TTS_LANGUAGE_MAP[language] || DEFAULT_TTS_LANGUAGE };
    if (Number.isFinite(speed)) body.speed = speed;
    const response = await fetch(config.ttsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async function synthesizeLong({ text, language = 'ko' }) {
    const response = await fetch(config.ttsLongUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: toMultilineSpeechText({ text, language }), language: TTS_LANGUAGE_MAP[language] || DEFAULT_TTS_LANGUAGE }),
      signal: AbortSignal.timeout(LONG_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new Error(`TTS(요약본) HTTP ${response.status} ${body}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  return { synthesize, synthesizeLong };
}

module.exports = { createTtsClient, sanitizeForSpeech, sanitizeMultilineForSpeech, TTS_LANGUAGE_MAP };
