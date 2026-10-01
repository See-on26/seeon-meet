import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  requestVlmContent, setVlmFallbackListener, resetVlmCircuit, GPU_BYPASS_MS,
} = require('../src/main/caption-pipeline/agents/shared/vlm-gateway.js');

const GPU_URL = 'http://127.0.0.1:8801/v1/chat/completions';
const baseConfig = {
  vlmUrl: GPU_URL, vlmModel: 'qwen', bedrockRegion: 'us-east-1', bedrockApiKey: 'key',
  isVlmFallbackEnabled: true, vlmFallbackModelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
};
const jpegBuffer = Buffer.from('jpeg-bytes');
const originalFetch = globalThis.fetch;
let callList;

function installFetch({ gpu, bedrock }) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    callList.push({ url, body });
    if (url === GPU_URL) return gpu();
    return bedrock();
  };
}

function jsonResponse(status, json) {
  return { ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) };
}

const bedrockOk = () => jsonResponse(200, { output: { message: { content: [{ text: '폴백 답' }] } } });

beforeEach(() => { callList = []; resetVlmCircuit(); setVlmFallbackListener(null); });
afterEach(() => { globalThis.fetch = originalFetch; });

test('GPU 정상이면 Bedrock 을 부르지 않는다', async () => {
  installFetch({ gpu: () => jsonResponse(200, { choices: [{ message: { content: 'GPU 답' } }] }), bedrock: bedrockOk });
  const text = await requestVlmContent({ config: baseConfig, jpegBuffer, prompt: 'p', label: 't' });
  assert.equal(text, 'GPU 답');
  assert.equal(callList.length, 1);
});

test('GPU 5xx 면 같은 프롬프트·이미지로 Haiku 에 보낸다', async () => {
  installFetch({ gpu: () => jsonResponse(503, {}), bedrock: bedrockOk });
  const text = await requestVlmContent({ config: baseConfig, jpegBuffer, prompt: '화면 설명', label: 't', maxTokens: 222 });
  assert.equal(text, '폴백 답');
  const bedrockCall = callList[1];
  assert.match(bedrockCall.url, /\/model\/us\.anthropic\.claude-haiku-4-5-20251001-v1:0\/converse$/);
  const [imageBlock, textBlock] = bedrockCall.body.messages[0].content;
  assert.deepEqual(imageBlock, { image: { format: 'jpeg', source: { bytes: jpegBuffer.toString('base64') } } });
  assert.deepEqual(textBlock, { text: '화면 설명' });
  assert.equal(bedrockCall.body.inferenceConfig.maxTokens, 222);
});

test('GPU 404(모델명 불일치)·연결 실패도 폴백한다', async () => {
  installFetch({ gpu: () => jsonResponse(404, {}), bedrock: bedrockOk });
  assert.equal(await requestVlmContent({ config: baseConfig, jpegBuffer, prompt: 'p', label: 't' }), '폴백 답');
  resetVlmCircuit();
  installFetch({ gpu: () => { throw new TypeError('fetch failed'); }, bedrock: bedrockOk });
  assert.equal(await requestVlmContent({ config: baseConfig, jpegBuffer, prompt: 'p', label: 't' }), '폴백 답');
});

test('GPU 빈 응답은 폴백하지 않는다 (파서가 NONE 처리)', async () => {
  installFetch({ gpu: () => jsonResponse(200, { choices: [{ message: { content: '' } }] }), bedrock: bedrockOk });
  const text = await requestVlmContent({ config: baseConfig, jpegBuffer, prompt: 'p', label: 't' });
  assert.equal(text, '');
  assert.equal(callList.length, 1);
});

test('Bedrock 키가 없으면 원래 GPU 에러를 그대로 던진다', async () => {
  installFetch({ gpu: () => jsonResponse(500, {}), bedrock: bedrockOk });
  await assert.rejects(
    requestVlmContent({ config: { ...baseConfig, bedrockApiKey: '' }, jpegBuffer, prompt: 'p', label: 't' }),
    /VLM\(t\) HTTP 500/,
  );
  assert.equal(callList.length, 1);
});

test('폴백을 끄면 원래 GPU 에러를 던진다', async () => {
  installFetch({ gpu: () => jsonResponse(500, {}), bedrock: bedrockOk });
  await assert.rejects(
    requestVlmContent({ config: { ...baseConfig, isVlmFallbackEnabled: false }, jpegBuffer, prompt: 'p', label: 't' }),
    /HTTP 500/,
  );
});

test('폴백도 실패하면 두 사유를 모두 담아 던진다', async () => {
  installFetch({ gpu: () => jsonResponse(500, {}), bedrock: () => jsonResponse(400, { message: 'model not found' }) });
  await assert.rejects(
    requestVlmContent({ config: baseConfig, jpegBuffer, prompt: 'p', label: 't' }),
    (error) => /HTTP 500/.test(error.message) && /Bedrock\(t·폴백\) HTTP 400/.test(error.message),
  );
});

test('한 번 실패하면 60초 동안 GPU 를 건너뛰고, 지나면 다시 GPU 를 시도한다', async () => {
  let nowMs = 1000;
  const now = () => nowMs;
  installFetch({ gpu: () => jsonResponse(503, {}), bedrock: bedrockOk });
  await requestVlmContent({ config: baseConfig, jpegBuffer, prompt: 'p', label: 't', now });
  nowMs += GPU_BYPASS_MS - 1;
  await requestVlmContent({ config: baseConfig, jpegBuffer, prompt: 'p', label: 't', now });
  assert.equal(callList.filter((call) => call.url === GPU_URL).length, 1);
  nowMs += 2;
  await requestVlmContent({ config: baseConfig, jpegBuffer, prompt: 'p', label: 't', now });
  assert.equal(callList.filter((call) => call.url === GPU_URL).length, 2);
});

test('폴백할 때마다 리스너에 알린다', async () => {
  const eventList = [];
  setVlmFallbackListener((event) => eventList.push(event));
  installFetch({ gpu: () => jsonResponse(503, {}), bedrock: bedrockOk });
  await requestVlmContent({ config: baseConfig, jpegBuffer, prompt: 'p', label: '지시해석' });
  await requestVlmContent({ config: baseConfig, jpegBuffer, prompt: 'p', label: '지시해석' });
  assert.equal(eventList.length, 2);
  assert.equal(eventList[0].label, '지시해석');
  assert.equal(eventList[0].isBypass, false);
  assert.match(eventList[0].reason, /HTTP 503/);
  assert.equal(eventList[1].isBypass, true);
});

test('설정: 폴백 기본 켜짐, 모델 기본값은 Haiku 4.5', () => {
  const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');
  const config = readPipelineConfig({});
  assert.equal(config.isVlmFallbackEnabled, true);
  assert.equal(config.vlmFallbackModelId, 'anthropic.claude-haiku-4-5-20251001-v1:0');
  assert.equal(readPipelineConfig({ SEEON_VLM_FALLBACK_ENABLED: 'false' }).isVlmFallbackEnabled, false);
});
