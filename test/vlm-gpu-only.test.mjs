import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vlmGateway = require('../src/main/caption-pipeline/agents/shared/vlm-gateway.js');
const { requestVlmContent } = vlmGateway;
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');

// QA: GPU VLM 이 응답하지 않을 때 Claude(Bedrock)로 넘기던 폴백을 없애고 GPU 서버만 쓴다.
// 설정은 실제 경로(readPipelineConfig)로 만든다. Bedrock 키가 있으면 예전에는 폴백이 기본으로 켜졌다.
const GPU_URL = 'http://127.0.0.1:8801/v1/chat/completions';
const config = { ...readPipelineConfig({ AWS_BEARER_TOKEN_BEDROCK: 'key' }), vlmUrl: GPU_URL };
const jpegBuffer = Buffer.from('jpeg-bytes');
const originalFetch = globalThis.fetch;
let callList;

function installFetch(gpu) {
  globalThis.fetch = async (url, init) => {
    callList.push({ url, body: JSON.parse(init.body) });
    if (url !== GPU_URL) return { ok: true, status: 200, json: async () => ({ output: { message: { content: [{ text: '클로드 답' }] } } }) };
    return gpu();
  };
}

const jsonResponse = (status, json) => ({ ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) });
const gpuOk = (content) => () => jsonResponse(200, { choices: [{ message: { content } }] });

beforeEach(() => { callList = []; });
afterEach(() => { globalThis.fetch = originalFetch; });

test('GPU 가 답하면 그 답을 돌려준다', async () => {
  installFetch(gpuOk('GPU 답'));
  assert.equal(await requestVlmContent({ config, jpegBuffer, prompt: 'p', label: 't' }), 'GPU 답');
  assert.deepEqual(callList.map((call) => call.url), [GPU_URL]);
});

test('GPU 가 실패하면 Bedrock 키가 있어도 Claude 를 부르지 않고 GPU 오류를 그대로 던진다', async () => {
  for (const gpu of [() => jsonResponse(503, {}), () => jsonResponse(404, {}), () => { throw new TypeError('fetch failed'); }]) {
    callList = [];
    installFetch(gpu);
    await assert.rejects(requestVlmContent({ config, jpegBuffer, prompt: 'p', label: 't' }), /VLM\(t\) HTTP (503|404)|fetch failed/);
    assert.deepEqual(callList.map((call) => call.url), [GPU_URL]);
  }
});

test('GPU 가 한 번 실패해도 다음 요청은 바로 GPU 로 간다(건너뛰는 창이 없다)', async () => {
  installFetch(() => jsonResponse(503, {}));
  await assert.rejects(requestVlmContent({ config, jpegBuffer, prompt: 'p', label: 't' }));
  installFetch(gpuOk('GPU 복구 답'));
  assert.equal(await requestVlmContent({ config, jpegBuffer, prompt: 'p', label: 't' }), 'GPU 복구 답');
  assert.deepEqual(callList.map((call) => call.url), [GPU_URL, GPU_URL]);
});

test('GPU 빈 응답은 그대로 돌려준다(파서가 NONE 처리)', async () => {
  installFetch(gpuOk(''));
  assert.equal(await requestVlmContent({ config, jpegBuffer, prompt: 'p', label: 't' }), '');
  assert.equal(callList.length, 1);
});

test('content 가 비어 reasoning 을 답으로 쓸 때는 그 답을 돌려주고 경고를 한 번 남긴다', async () => {
  installFetch(() => jsonResponse(200, { choices: [{ message: { content: '', reasoning: '생각 끝의 답' } }] }));
  const warnList = [];
  const originalWarn = console.warn;
  console.warn = (...argList) => { warnList.push(argList.join(' ')); };
  try {
    const answer = await requestVlmContent({ config, jpegBuffer, prompt: 'p', label: '시험' });
    assert.equal(answer, '생각 끝의 답');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnList.length, 1);
  assert.match(warnList[0], /content 가 비어 reasoning 을 답으로 쓴다/);
  assert.match(warnList[0], new RegExp(config.vlmModel));
});

test('폴백 설정·폴백 알림·우회 창은 더 이상 없다', () => {
  const pipelineConfig = readPipelineConfig({
    SEEON_VLM_FALLBACK_ENABLED: 'true', SEEON_BEDROCK_VLM_FALLBACK_MODEL_ID: 'anthropic.claude-haiku-4-5-20251001-v1:0',
  });
  assert.equal('isVlmFallbackEnabled' in pipelineConfig, false);
  assert.equal('vlmFallbackModelId' in pipelineConfig, false);
  for (const name of ['setVlmFallbackListener', 'resetVlmCircuit', 'GPU_BYPASS_MS']) assert.equal(name in vlmGateway, false, name);
});
