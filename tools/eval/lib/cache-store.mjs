import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function hashInput(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// 입력 해시 → JSON 파일. 같은 입력으로 다시 돌리면 Bedrock 을 부르지 않는다.
export function createCacheStore({ cacheDir = null } = {}) {
  if (!cacheDir) return { isEnabled: false, read: () => null, write: () => {} };
  fs.mkdirSync(cacheDir, { recursive: true });
  const toFilePath = (key) => path.join(cacheDir, `${key}.json`);
  return {
    isEnabled: true,
    read(key) {
      try {
        return JSON.parse(fs.readFileSync(toFilePath(key), 'utf8'));
      } catch {
        return null;
      }
    },
    write(key, value) {
      fs.writeFileSync(toFilePath(key), JSON.stringify(value), 'utf8');
    },
  };
}
