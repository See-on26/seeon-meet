import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVlmTraffic, defaultVlmTraffic } = require('../src/main/caption-pipeline/agents/shared/vlm-traffic.js');
const { requestVlmCompletion, requestVlmContent, VLM_PRIORITY_MAP } = require('../src/main/caption-pipeline/agents/shared/vlm-gateway.js');

// 요약 같은 긴 글 요청은 배경 순위로 보내 실시간 해설(전경) 요청이 없을 때만 GPU 에 간다.
const config = { vlmUrl: 'http://127.0.0.1:8801/v1/chat/completions', vlmModel: 'gemma', vlmMaxSoftTokens: null };
const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

const flush = () => new Promise((resolve) => setImmediate(resolve));

// 가짜 시계: sleep 은 advance 로 시계를 그 시각까지 옮길 때 깬다.
function createFakeTimer() {
  let nowMs = 0;
  let timerList = [];
  const now = () => nowMs;
  const sleep = (ms) => new Promise((resolve) => { timerList.push({ wakeAt: nowMs + ms, resolve }); });
  async function advance(ms) {
    const targetAt = nowMs + ms;
    await flush();
    for (;;) {
      const next = timerList.filter((timer) => timer.wakeAt <= targetAt).sort((a, b) => a.wakeAt - b.wakeAt)[0];
      if (!next) break;
      timerList = timerList.filter((timer) => timer !== next);
      nowMs = next.wakeAt;
      next.resolve();
      await flush();
    }
    nowMs = targetAt;
    await flush();
  }
  return { now, sleep, advance };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const jsonResponse = (status, json) => ({ ok: status < 400, status, json: async () => json });

function createFakeTraffic() {
  const callList = [];
  return {
    callList,
    runForeground: (task) => { callList.push('foreground'); return task(); },
    runBackground: (task) => { callList.push('background'); return task(); },
  };
}

test('vlm-traffic: 전경 요청이 진행 중이면 배경은 끝나고 quietMs 뒤에 시작한다', async () => {
  const timer = createFakeTimer();
  const traffic = createVlmTraffic({ quietMs: 300, maxWaitMs: 60000, now: timer.now, sleep: timer.sleep });
  const foreground = createDeferred();
  const foregroundPromise = traffic.runForeground(() => foreground.promise);
  let backgroundStartAt = null;
  const backgroundPromise = traffic.runBackground(async () => { backgroundStartAt = timer.now(); return '배경 답'; });

  await timer.advance(1000);
  assert.equal(backgroundStartAt, null, '전경이 도는 동안은 배경을 시작하지 않는다');

  foreground.resolve('전경 답');
  assert.equal(await foregroundPromise, '전경 답');
  assert.equal(traffic.getForegroundInFlight(), 0);
  await timer.advance(299);
  assert.equal(backgroundStartAt, null, '전경이 끝나고 quietMs 가 지나기 전에는 시작하지 않는다');
  await timer.advance(1);
  assert.equal(backgroundStartAt, 1300);
  assert.equal(await backgroundPromise, '배경 답');
});

test('vlm-traffic: maxWaitMs 를 넘기면 전경이 계속 있어도 배경을 시작한다', async () => {
  const timer = createFakeTimer();
  const traffic = createVlmTraffic({ quietMs: 300, maxWaitMs: 5000, now: timer.now, sleep: timer.sleep });
  traffic.runForeground(() => createDeferred().promise);
  let backgroundStartAt = null;
  const backgroundPromise = traffic.runBackground(async () => { backgroundStartAt = timer.now(); return '배경 답'; });

  await timer.advance(4999);
  assert.equal(backgroundStartAt, null);
  await timer.advance(1);
  assert.equal(backgroundStartAt, 5000);
  assert.equal(traffic.getForegroundInFlight(), 1);
  assert.equal(await backgroundPromise, '배경 답');
});

test('vlm-traffic: 배경이 도는 중에도 전경은 바로 시작한다', async () => {
  const timer = createFakeTimer();
  const traffic = createVlmTraffic({ quietMs: 300, now: timer.now, sleep: timer.sleep });
  const background = createDeferred();
  let isBackgroundStarted = false;
  const backgroundPromise = traffic.runBackground(() => { isBackgroundStarted = true; return background.promise; });
  await timer.advance(0);
  assert.equal(isBackgroundStarted, true, '전경이 없으면 배경은 기다리지 않는다');

  let isForegroundStarted = false;
  const foregroundPromise = traffic.runForeground(async () => { isForegroundStarted = true; return '전경 답'; });
  assert.equal(isForegroundStarted, true);
  assert.equal(traffic.getForegroundInFlight(), 1);
  assert.equal(await foregroundPromise, '전경 답');

  await assert.rejects(traffic.runForeground(async () => { throw new Error('GPU 실패'); }), /GPU 실패/);
  assert.equal(traffic.getForegroundInFlight(), 0, '실패한 전경도 진행 중 수에서 빠진다');

  background.resolve('배경 답');
  assert.equal(await backgroundPromise, '배경 답');
});

test('requestVlmCompletion: finish_reason 을 함께 돌려주고 배경 순위면 traffic.runBackground 로 보낸다', async () => {
  const traffic = createFakeTraffic();
  const requestList = [];
  const fetchImpl = async (url, init) => {
    requestList.push({ url, body: JSON.parse(init.body) });
    return jsonResponse(200, { choices: [{ message: { content: '요약' }, finish_reason: 'length' }] });
  };
  const result = await requestVlmCompletion({
    config, prompt: '요약해라', label: '요약', temperature: 0, maxTokens: 6000, timeoutMs: 240000,
    priority: VLM_PRIORITY_MAP.background, traffic, fetchImpl,
  });
  assert.deepEqual(result, { content: '요약', finishReason: 'length' });
  assert.deepEqual(traffic.callList, ['background']);
  assert.equal(requestList.length, 1);
  assert.equal(requestList[0].url, config.vlmUrl);
  assert.equal(requestList[0].body.max_tokens, 6000);
  assert.equal(requestList[0].body.temperature, 0);

  const foregroundTraffic = createFakeTraffic();
  const noReasonFetch = async () => jsonResponse(200, { choices: [{ message: { content: '답' } }] });
  const foregroundResult = await requestVlmCompletion({ config, prompt: 'p', label: 't', traffic: foregroundTraffic, fetchImpl: noReasonFetch });
  assert.deepEqual(foregroundResult, { content: '답', finishReason: null });
  assert.deepEqual(foregroundTraffic.callList, ['foreground'], '순위를 주지 않으면 전경이다');
});

test('requestVlmCompletion: 시간 제한은 기다림이 끝나고 요청을 보낼 때부터 잰다', async () => {
  const traffic = {
    runForeground: (task) => task(),
    runBackground: async (task) => { await new Promise((resolve) => setTimeout(resolve, 80)); return task(); },
  };
  let isAbortedAtSend = null;
  const fetchImpl = async (url, init) => {
    isAbortedAtSend = init.signal.aborted;
    return jsonResponse(200, { choices: [{ message: { content: '요약' }, finish_reason: 'stop' }] });
  };
  const result = await requestVlmCompletion({
    config, prompt: 'p', label: 't', timeoutMs: 30, priority: VLM_PRIORITY_MAP.background, traffic, fetchImpl,
  });
  assert.equal(isAbortedAtSend, false, '기다린 80ms 가 시간 제한 30ms 에 들어가지 않는다');
  assert.deepEqual(result, { content: '요약', finishReason: 'stop' });
});

test('requestVlmContent: 지금처럼 문자열만 돌려주고 전경으로 보낸다', async () => {
  const foregroundInFlightList = [];
  globalThis.fetch = async () => {
    foregroundInFlightList.push(defaultVlmTraffic.getForegroundInFlight());
    return jsonResponse(200, { choices: [{ message: { content: '해설' }, finish_reason: 'stop' }] });
  };
  const answer = await requestVlmContent({ config, jpegBuffer: Buffer.from('jpeg-bytes'), prompt: 'p', label: 't' });
  assert.equal(answer, '해설');
  assert.deepEqual(foregroundInFlightList, [1], '요청을 보내는 동안 앱 공용 traffic 의 전경 진행 중 수가 1 이다');
  assert.equal(defaultVlmTraffic.getForegroundInFlight(), 0);
});
