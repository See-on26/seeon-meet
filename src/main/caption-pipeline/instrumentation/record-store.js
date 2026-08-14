const fs = require('fs');
const path = require('path');

const RECORD_KIND_MAP = {
  frame: 'frame',
  factSheet: 'fact_sheet',
  asr: 'asr',
  caption: 'caption',
  tts: 'tts',
  error: 'error',
  latency: 'latency',
  boundary: 'boundary',
  deixis: 'deixis',
  pageTransition: 'page_transition',
  slideMark: 'slide_mark',
  speakerIdentity: 'speaker_identity',
  narration: 'narration',
  gap: 'gap',
  debug: 'debug',
};

function createRecordStore({ outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `pipeline-${Date.now()}.jsonl`);
  let writeChain = Promise.resolve();

  function append(record) {
    const writePromise = writeChain.then(() =>
      fs.promises.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8'));
    writeChain = writePromise.catch((error) => {
      console.error('[pipeline] 레코드 적재 실패:', error.message);
    });
    return writePromise;
  }

  return { filePath, append };
}

module.exports = { createRecordStore, RECORD_KIND_MAP };
