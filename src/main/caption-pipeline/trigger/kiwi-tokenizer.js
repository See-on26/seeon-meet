const fs = require('fs');
const path = require('path');
const { KIWI_MODEL_FILE_LIST } = require('./kiwi-model');

// app.asar 안의 wasm 은 asarUnpack 으로 풀어 둔 경로를 쓴다(없으면 원래 경로).
function resolveKiwiWasmPath({ fileExists = fs.existsSync } = {}) {
  const wasmPath = require.resolve('kiwi-nlp/dist/kiwi-wasm.wasm');
  const unpackedPath = wasmPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return unpackedPath !== wasmPath && fileExists(unpackedPath) ? unpackedPath : wasmPath;
}

// Kiwi 형태소 분석기. 모델을 읽어 만드는 데 1초 남짓 걸리고 그동안 이 스레드가 멈추므로 앱이 뜬 뒤 한 번만 만든다.
// 준비되기 전이나 실패했으면 tokenize 가 null 을 돌려주고, 호출부는 규칙 기반으로 대신한다.
function createKiwiTokenizer({
  modelDir, importKiwi = () => import('kiwi-nlp'), readFile = (filePath) => fs.promises.readFile(filePath),
  resolveWasmPath = resolveKiwiWasmPath, now = Date.now,
}) {
  let kiwi = null;
  let loadPromise = null;
  let failureMessage = '';

  async function build() {
    const startedAt = now();
    const { KiwiBuilder } = await importKiwi();
    const builder = await KiwiBuilder.create(resolveWasmPath());
    const fileEntryList = await Promise.all(KIWI_MODEL_FILE_LIST.map(async (name) => (
      [name, new Uint8Array(await readFile(path.join(modelDir, name)))])));
    kiwi = await builder.build({
      modelFiles: Object.fromEntries(fileEntryList),
      loadDefaultDict: true, loadTypoDict: false, loadMultiDict: false,
    });
    return { elapsedMs: now() - startedAt };
  }

  function load() {
    if (!loadPromise) {
      loadPromise = build().catch((error) => {
        failureMessage = error.message || String(error);
        kiwi = null;
        throw error;
      });
    }
    return loadPromise;
  }

  // 형태소마다 품사와 원문 위치(start·end, UTF-16 인덱스)를 돌려준다.
  function tokenize(text) {
    if (!kiwi || typeof text !== 'string' || !text.trim()) return null;
    return kiwi.tokenize(text).map((token) => ({
      form: token.str, tag: token.tag, start: token.position, end: token.position + token.length,
    }));
  }

  return {
    load, tokenize, isReady: () => Boolean(kiwi), getFailureMessage: () => failureMessage,
  };
}

module.exports = { createKiwiTokenizer, resolveKiwiWasmPath };
