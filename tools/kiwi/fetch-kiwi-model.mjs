// 한국어 트리거용 Kiwi 형태소 분석 모델을 vendor/kiwi-model 에 받는다. 이미 같은 버전이 있으면 건너뛴다.
// 사용: npm run setup:kiwi   (dist:win · dist:mac:dir 전에 자동으로 돈다)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  KIWI_MODEL_VERSION, KIWI_MODEL_ARCHIVE_URL, KIWI_MODEL_FILE_LIST, DEV_KIWI_MODEL_DIR,
} = require('../../src/main/caption-pipeline/trigger/kiwi-model.js');

const VERSION_FILE_NAME = 'VERSION';
const TAR_BLOCK_SIZE = 512;

export function isModelReady({ modelDir, fileExists = fs.existsSync, readText = (filePath) => fs.readFileSync(filePath, 'utf8') }) {
  if (!KIWI_MODEL_FILE_LIST.every((name) => fileExists(path.join(modelDir, name)))) return false;
  const versionPath = path.join(modelDir, VERSION_FILE_NAME);
  return fileExists(versionPath) && readText(versionPath).trim() === KIWI_MODEL_VERSION;
}

function readTarString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

// ustar 묶음에서 이름(basename)이 wantedNameSet 에 든 일반 파일만 꺼낸다. 외부 tar 명령 없이 Windows 에서도 돈다.
export function extractTarFileMap({ tarBuffer, wantedNameSet }) {
  const fileMap = new Map();
  let offset = 0;
  let longName = null;
  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || '0', 8);
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefix = readTarString(header, 345, 155);
    const shortName = readTarString(header, 0, 100);
    const dataStart = offset + TAR_BLOCK_SIZE;
    const data = tarBuffer.subarray(dataStart, dataStart + size);
    if (typeFlag === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
    } else {
      const name = longName || (prefix ? `${prefix}/${shortName}` : shortName);
      longName = null;
      const baseName = path.posix.basename(name);
      if ((typeFlag === '0' || typeFlag === '\0') && wantedNameSet.has(baseName)) fileMap.set(baseName, Buffer.from(data));
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return fileMap;
}

async function main() {
  const modelDir = DEV_KIWI_MODEL_DIR;
  if (isModelReady({ modelDir })) {
    console.log(`[kiwi] 모델 ${KIWI_MODEL_VERSION} 이미 있음 — ${modelDir}`);
    return;
  }
  console.log(`[kiwi] 모델 ${KIWI_MODEL_VERSION} 받는 중 — ${KIWI_MODEL_ARCHIVE_URL}`);
  const response = await fetch(KIWI_MODEL_ARCHIVE_URL);
  if (!response.ok) throw new Error(`Kiwi 모델 다운로드 실패: HTTP ${response.status}`);
  const tarBuffer = zlib.gunzipSync(Buffer.from(await response.arrayBuffer()));
  const fileMap = extractTarFileMap({ tarBuffer, wantedNameSet: new Set(KIWI_MODEL_FILE_LIST) });
  const missingList = KIWI_MODEL_FILE_LIST.filter((name) => !fileMap.has(name));
  if (missingList.length) throw new Error(`Kiwi 모델 묶음에 파일이 없다: ${missingList.join(', ')}`);
  fs.mkdirSync(modelDir, { recursive: true });
  for (const [name, data] of fileMap) fs.writeFileSync(path.join(modelDir, name), data);
  fs.writeFileSync(path.join(modelDir, VERSION_FILE_NAME), `${KIWI_MODEL_VERSION}\n`);
  const totalMb = [...fileMap.values()].reduce((sum, data) => sum + data.length, 0) / 1024 / 1024;
  console.log(`[kiwi] 모델 저장 완료 — ${modelDir} (${totalMb.toFixed(1)}MB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[kiwi] ${error.message}`);
    process.exit(1);
  });
}
