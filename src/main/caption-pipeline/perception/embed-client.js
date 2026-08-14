const REQUEST_TIMEOUT_MS = 8000;

function createEmbedClient({ config }) {
  async function embedFrame({ jpegBuffer }) {
    const response = await fetch(config.embedUrl, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: jpegBuffer,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`EMBED HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.embedding) || !body.embedding.length) {
      throw new Error('EMBED 응답에 embedding 배열 없음');
    }
    return body.embedding;
  }

  return { embedFrame };
}

module.exports = { createEmbedClient };
