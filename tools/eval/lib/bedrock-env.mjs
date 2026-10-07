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

// 토큰이 없으면 3.1 은 GPU 판정이 실패한 호출을 Bedrock 이 대신 판정하지 못해 "판정 실패(해설 안 함)"로 떨어지고,
// 3.2 는 답변 모델을 부르지 못한다. 그대로 돌리면 지표가 의미 없으므로 시작할 때 멈춘다.
export function assertBedrockToken({ env = process.env } = {}) {
  if (!env.AWS_BEARER_TOKEN_BEDROCK) {
    throw new Error('AWS_BEARER_TOKEN_BEDROCK 이 없다 — Bedrock 을 부를 수 없어 평가를 멈춘다 (.env 확인)');
  }
}
