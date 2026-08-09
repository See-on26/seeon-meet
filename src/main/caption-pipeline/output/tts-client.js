const REQUEST_TIMEOUT_MS = 15000;

const LONG_REQUEST_TIMEOUT_MS = 600000;

const SYMBOL_READING_MAP = {
  '&': '앤드',
  '=': '는',
};

const LEADING_CURRENCY_PATTERN = /\$\s*([\d,.]+)/g;

const UNSPEAKABLE_SYMBOL_PATTERN = /[&<>$@|`{}=+]/g;

function sanitizeForSpeech({ text }) {
  return String(text || '')
    .replace(LEADING_CURRENCY_PATTERN, '$1달러')
    .replace(UNSPEAKABLE_SYMBOL_PATTERN, (symbol) => SYMBOL_READING_MAP[symbol] || ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeMultilineForSpeech({ text }) {
  return String(text || '')
    .split('\n')
    .map((line) => sanitizeForSpeech({ text: line }))
    .join('\n');
}

function createTtsClient({ config }) {
  async function synthesize({ text }) {
    const response = await fetch(config.ttsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: sanitizeForSpeech({ text }) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async function synthesizeLong({ text }) {
    const response = await fetch(config.ttsLongUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: sanitizeMultilineForSpeech({ text }) }),
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

module.exports = { createTtsClient, sanitizeForSpeech, sanitizeMultilineForSpeech };
