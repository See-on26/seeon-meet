import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');
const { buildVlmRequestBody, requestVlmContent } = require('../src/main/caption-pipeline/agents/shared/vlm-gateway.js');

// SEEON_VLM_MAX_SOFT_TOKENS 는 VLM 서버가 그림 한 장을 몇 개의 이미지 토큰으로 나눌지(해상도)를 요청마다 고르게 한다.
// 값이 없으면 서버 기본값을 그대로 쓰도록 요청 몸통을 지금과 똑같이 둔다.
const jpegBuffer = Buffer.from('jpeg-bytes');
const imageUrl = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
const originalFetch = globalThis.fetch;

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
});

function installFetch() {
  const bodyList = [];
  globalThis.fetch = async (url, init) => {
    bodyList.push(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '답' } }] }) };
  };
  return bodyList;
}

test('설정: SEEON_VLM_MAX_SOFT_TOKENS 가 없거나 비면 null 이고 경고하지 않는다', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(readPipelineConfig({}).vlmMaxSoftTokens, null);
  assert.equal(readPipelineConfig({ SEEON_VLM_MAX_SOFT_TOKENS: '' }).vlmMaxSoftTokens, null);
  assert.equal(warn.mock.callCount(), 0);
});

test('설정: 양의 정수면 그 수로 읽는다', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(readPipelineConfig({ SEEON_VLM_MAX_SOFT_TOKENS: '1120' }).vlmMaxSoftTokens, 1120);
  assert.equal(readPipelineConfig({ SEEON_VLM_MAX_SOFT_TOKENS: '560' }).vlmMaxSoftTokens, 560);
  assert.equal(warn.mock.callCount(), 0);
});

test('설정: 양의 정수가 아니면 값마다 한 번 경고하고 null 로 둔다', () => {
  const warn = mock.method(console, 'warn', () => {});
  const invalidList = ['0', '-560', '1.5', 'abc', '1120px', '０'];
  for (const value of invalidList) {
    assert.equal(readPipelineConfig({ SEEON_VLM_MAX_SOFT_TOKENS: value }).vlmMaxSoftTokens, null, value);
  }
  assert.equal(warn.mock.callCount(), invalidList.length);
  for (const call of warn.mock.calls) assert.match(call.arguments[0], /SEEON_VLM_MAX_SOFT_TOKENS/);
});

test('몸통: 값이 없으면 지금과 바이트까지 같은 몸통을 만든다', () => {
  const expectedJson = JSON.stringify({
    model: 'm',
    temperature: 0.2,
    max_tokens: 200,
    chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }, { type: 'text', text: 'p' }] }],
  });
  assert.equal(JSON.stringify(buildVlmRequestBody({ jpegBuffer, vlmModel: 'm', prompt: 'p' })), expectedJson);
  assert.equal(JSON.stringify(buildVlmRequestBody({ jpegBuffer, vlmModel: 'm', prompt: 'p', maxSoftTokens: null })), expectedJson);
});

test('몸통: 값이 있고 그림이 있으면 mm_processor_kwargs.max_soft_tokens 를 넣는다', () => {
  const body = buildVlmRequestBody({ jpegBuffer, vlmModel: 'm', prompt: 'p', maxSoftTokens: 1120 });
  assert.deepEqual(body.mm_processor_kwargs, { max_soft_tokens: 1120 });
  assert.equal(body.messages[0].content[0].type, 'image_url');
});

test('몸통: 그림 없는 글 요청은 값이 있어도 넣지 않는다(이미지 토큰에만 쓰이는 값)', () => {
  const body = buildVlmRequestBody({ vlmModel: 'm', prompt: 'p', maxSoftTokens: 1120 });
  assert.equal('mm_processor_kwargs' in body, false);
});

test('요청: 설정에 값이 있으면 실제로 보내는 몸통에 들어가고, 없으면 들어가지 않는다', async () => {
  const bodyList = installFetch();
  const withConfig = readPipelineConfig({ SEEON_VLM_MAX_SOFT_TOKENS: '1120' });
  await requestVlmContent({ config: withConfig, jpegBuffer, prompt: 'p', label: 't' });
  assert.deepEqual(JSON.parse(bodyList[0]).mm_processor_kwargs, { max_soft_tokens: 1120 });

  const withoutConfig = readPipelineConfig({});
  await requestVlmContent({ config: withoutConfig, jpegBuffer, prompt: 'p', label: 't' });
  assert.equal(bodyList[1], JSON.stringify(buildVlmRequestBody({
    jpegBuffer, vlmModel: withoutConfig.vlmModel, prompt: 'p',
  })));
  assert.equal('mm_processor_kwargs' in JSON.parse(bodyList[1]), false);
});

// 발화 ROI 는 해설 요청 하나에 [화면 전체, 확대] 두 장을 넣는다. 이미지 토큰 상한은 요청 단위라 두 장에 함께 걸린다.
test('몸통: 두 장이면 글 앞에 [첫째, 둘째] 순서로 넣고, 상한 칸은 한 번만 넣는다', () => {
  const zoomBuffer = Buffer.from('zoom-bytes');
  const body = buildVlmRequestBody({ jpegBufferList: [jpegBuffer, zoomBuffer], vlmModel: 'm', prompt: 'p', maxSoftTokens: 560 });
  assert.deepEqual(body.mm_processor_kwargs, { max_soft_tokens: 560 });
  assert.deepEqual(body.messages[0].content.map((block) => block.type), ['image_url', 'image_url', 'text']);
  assert.equal(body.messages[0].content[0].image_url.url, imageUrl);
  assert.equal(body.messages[0].content[1].image_url.url, `data:image/jpeg;base64,${zoomBuffer.toString('base64')}`);
  const withoutLimit = buildVlmRequestBody({ jpegBufferList: [jpegBuffer, zoomBuffer], vlmModel: 'm', prompt: 'p' });
  assert.equal('mm_processor_kwargs' in withoutLimit, false);
});
