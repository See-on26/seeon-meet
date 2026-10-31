import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');
const { createJudgeLlm, JUDGE_SOURCE_MAP } = require('../src/main/caption-pipeline/agents/shared/judge-llm.js');

// 판단·해설·삽입 위치·질문 답·회의 요약 모두 자체 GPU 서버에서만 처리한다. 회의 화면·전사를 외부 AI API 로 보내는 경로를 두지 않는다.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const EXTERNAL_AI_MARKER_LIST = [
  'bedrock-converse', 'bedrock-runtime', 'amazonaws.com', 'AWS_BEARER_TOKEN_BEDROCK',
  'api.openai.com', 'generativelanguage.googleapis.com', 'api.anthropic.com',
];

function listSourceFile(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFile(fullPath);
    return /\.(c?js|mjs)$/.test(entry.name) ? [fullPath] : [];
  });
}

test('Bedrock 호출 모듈이 없고, 제품 코드 어디도 Bedrock·외부 AI 서비스를 부르지 않는다', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'src/main/caption-pipeline/agents/shared/bedrock-converse.js')), false);
  for (const filePath of listSourceFile(path.join(repoRoot, 'src'))) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const marker of EXTERNAL_AI_MARKER_LIST) {
      assert.ok(!source.includes(marker), `${path.relative(repoRoot, filePath)} 에 ${marker}`);
    }
  }
});

test('설정에 Bedrock·판정 백엔드 칸이 없고, 환경 변수로 Bedrock 을 골라도 판정은 GPU 서버로 간다', async () => {
  const config = readPipelineConfig({
    AWS_BEARER_TOKEN_BEDROCK: 'token', SEEON_JUDGE_BACKEND: 'bedrock',
    SEEON_BEDROCK_MODEL_ID: 'anthropic.claude-sonnet-5', SEEON_BEDROCK_REGION: 'us-east-1',
  });
  assert.deepEqual(Object.keys(config).filter((key) => /bedrock|judgeBackend|judgeModelId/i.test(key)), []);
  const urlList = [];
  const judgeLlm = createJudgeLlm({
    config,
    fetchImpl: async (url) => {
      urlList.push(url);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"cue":true}' } }] }) };
    },
  });
  const result = await judgeLlm.requestText({ systemPrompt: '규칙', messageList: [], maxTokens: 10, timeoutMs: 1000, label: '시험' });
  assert.equal(result.source, JUDGE_SOURCE_MAP.gpu);
  assert.deepEqual(urlList, [config.judgeGpuUrl]);
  assert.deepEqual(Object.keys(JUDGE_SOURCE_MAP), ['gpu']);
});

test('설치본에 Bedrock SDK 가 들어가지 않는다', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.ok(!('@anthropic-ai/bedrock-sdk' in (packageJson.dependencies || {})));
  assert.ok(!('@anthropic-ai/bedrock-sdk' in (packageJson.devDependencies || {})));
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  assert.ok(!('node_modules/@anthropic-ai/bedrock-sdk' in (lock.packages || {})));
});
