import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const KIWI_MODEL_FILE_LIST = [
  'combiningRule.txt', 'cong.mdl', 'default.dict', 'dialect.dict', 'extract.mdl',
  'multi.dict', 'nounchr.mdl', 'sj.morph', 'typo.dict',
];

// 모델(약 88MB)은 저장소에 넣지 않는다. tools/eval/setup-kiwi.sh 가 out/cache/kiwi-model 에 받는다.
export function resolveKiwiModelDir({ env = process.env } = {}) {
  const baseDir = env.SEEON_KIWI_MODEL_DIR || path.join(REPO_ROOT, 'out', 'cache', 'kiwi-model');
  return path.join(baseDir, 'models', 'cong', 'base');
}

export function hasKiwiModel({ modelDir = resolveKiwiModelDir() } = {}) {
  return KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(modelDir, name)));
}

export async function createKiwiAnalyzer({
  modelDir = resolveKiwiModelDir(), importKiwi = () => import('kiwi-nlp'),
} = {}) {
  if (!hasKiwiModel({ modelDir })) {
    throw new Error(`Kiwi 모델이 없다: ${modelDir} — tools/eval/setup-kiwi.sh 로 받는다`);
  }
  const { KiwiBuilder } = await importKiwi();
  const wasmPath = path.join(path.dirname(require.resolve('kiwi-nlp')), 'kiwi-wasm.wasm');
  const builder = await KiwiBuilder.create(wasmPath);
  const modelFiles = {};
  for (const name of KIWI_MODEL_FILE_LIST) modelFiles[name] = new Uint8Array(fs.readFileSync(path.join(modelDir, name)));
  const kiwi = await builder.build({ modelFiles, modelType: 'cong' });
  return {
    version: builder.version(),
    analyze(text) {
      return kiwi.analyze(text).tokens.map((token) => ({
        form: token.str, tag: token.tag, position: token.position, length: token.length,
      }));
    },
  };
}
