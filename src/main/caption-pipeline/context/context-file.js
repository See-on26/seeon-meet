const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE_MS = 2000;

function toSafeFileStem(sessionId) {
  return String(sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
}

// 저장소가 바뀔 때마다 쓰면 디스크를 계속 두드리므로 묶어서 쓴다. 쓰기 실패는 회의 기능을 막지 않는다.
function createContextFileWriter({ outDir, writeFile = fs.promises.writeFile, mkdir = fs.promises.mkdir,
  debounceMs = DEFAULT_DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null;
  let timerHandle = null;

  function filePathFor(sessionId) {
    return path.join(outDir, `${toSafeFileStem(sessionId)}.json`);
  }

  async function writeSafely({ filePath, text }) {
    try {
      await mkdir(outDir, { recursive: true });
      await writeFile(filePath, text, 'utf8');
      return filePath;
    } catch (error) {
      console.warn(`[context] 파일 쓰기 실패(무시) ${filePath}: ${error.message}`);
      return null;
    }
  }

  async function flush() {
    if (timerHandle !== null) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
    if (!pending) return null;
    const { sessionId, getSnapshot } = pending;
    pending = null;
    if (!toSafeFileStem(sessionId)) return null;
    return writeSafely({ filePath: filePathFor(sessionId), text: JSON.stringify(getSnapshot(), null, 2) });
  }

  function schedule({ sessionId, getSnapshot }) {
    pending = { sessionId, getSnapshot };
    if (timerHandle !== null) return;
    timerHandle = setTimer(() => {
      timerHandle = null;
      return flush();
    }, debounceMs);
  }

  function writeText({ fileName, text }) {
    return writeSafely({ filePath: path.join(outDir, path.basename(fileName)), text });
  }

  return { schedule, flush, writeText, filePathFor };
}

module.exports = { createContextFileWriter };
