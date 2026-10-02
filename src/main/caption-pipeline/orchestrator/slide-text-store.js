const SLIDE_TEXT_STATUS_MAP = {
  missing: 'missing',
  pending: 'pending',
  ready: 'ready',
  failed: 'failed',
  none: 'none',
};

function toMajorKey(slideLabel) {
  return String(slideLabel ?? '').split('-')[0];
}

// 새 슬라이드(major)마다 화면 글자를 한 번 전사해 두고, 값 슬롯 검사가 꺼내 쓴다.
function createSlideTextStore({ transcribe, onSettled = () => {} }) {
  let entryByKeyMap = new Map();

  function settle({ key, entry, status, text = '', errorMessage = '' }) {
    entry.status = status;
    entry.text = text;
    onSettled({ slideLabel: key, status, textLength: text.length, errorMessage });
  }

  function ensure({ slideLabel, jpegBuffer }) {
    const key = toMajorKey(slideLabel);
    if (!key || entryByKeyMap.has(key)) return false;
    const entry = { status: SLIDE_TEXT_STATUS_MAP.pending, text: '', promise: null };
    entryByKeyMap.set(key, entry);
    entry.promise = Promise.resolve()
      .then(() => transcribe({ jpegBuffer }))
      .then(({ text, hasText }) => settle({
        key, entry, status: hasText ? SLIDE_TEXT_STATUS_MAP.ready : SLIDE_TEXT_STATUS_MAP.none, text,
      }))
      .catch((error) => settle({
        key, entry, status: SLIDE_TEXT_STATUS_MAP.failed, errorMessage: error.message,
      }));
    return true;
  }

  function get(slideLabel) {
    const entry = entryByKeyMap.get(toMajorKey(slideLabel));
    if (!entry) return { status: SLIDE_TEXT_STATUS_MAP.missing, text: '' };
    return { status: entry.status, text: entry.text };
  }

  async function waitFor(slideLabel) {
    await entryByKeyMap.get(toMajorKey(slideLabel))?.promise;
  }

  function reset() {
    entryByKeyMap = new Map();
  }

  return { ensure, get, waitFor, reset };
}

module.exports = { createSlideTextStore, SLIDE_TEXT_STATUS_MAP };
