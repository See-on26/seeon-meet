import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function loadRepoEnv({ envFilePath = path.join(REPO_ROOT, '.env'), loadEnvFile = process.loadEnvFile } = {}) {
  try {
    loadEnvFile(envFilePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// 라우터는 토큰이 없으면 모두 통과로 처리한다. 그대로 돌리면 지표가 의미 없으므로 시작할 때 멈춘다.
export function assertBedrockToken({ env = process.env } = {}) {
  if (!env.AWS_BEARER_TOKEN_BEDROCK) {
    throw new Error('AWS_BEARER_TOKEN_BEDROCK 이 없다 — 판정기가 모두 통과·차단으로 떨어지므로 평가를 멈춘다 (.env 확인)');
  }
}
