import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  captureWhenSettled, SETTLED_CAPTURE_WAIT_MS, SETTLED_CAPTURE_POLL_MS,
} from '../src/renderer/core/capture/settled-capture.js';

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

// 기다리는 동안만 시간이 흐르는 가짜 시계.
function makeClock() {
  let nowMs = 0;
  const waitList = [];
  return {
    now: () => nowMs,
    wait: async (ms) => { waitList.push(ms); nowMs += ms; },
    waitList,
  };
}

test('좌표가 자리 잡는 중이 아니면 기다리지 않고 바로 찍는다', async () => {
  const clock = makeClock();
  const buffer = await captureWhenSettled({
    isSettling: () => false, capture: async () => `frame@${clock.now()}`, now: clock.now, wait: clock.wait,
  });
  assert.equal(buffer, 'frame@0');
  assert.deepEqual(clock.waitList, []);
});

test('Meet 화면 크기가 바뀐 직후면 좌표가 자리 잡을 때까지 기다렸다가 찍는다', async () => {
  const clock = makeClock();
  const buffer = await captureWhenSettled({
    isSettling: () => clock.now() < 1250, capture: async () => `frame@${clock.now()}`, now: clock.now, wait: clock.wait,
  });
  assert.equal(buffer, `frame@${Math.ceil(1250 / SETTLED_CAPTURE_POLL_MS) * SETTLED_CAPTURE_POLL_MS}`);
  assert.ok(clock.waitList.every((ms) => ms === SETTLED_CAPTURE_POLL_MS));
});

test('상한(2초)이 지나도 자리 잡지 않으면 더 기다리지 않고 지금 화면을 찍어 본다(찍지 못하면 null)', async () => {
  assert.equal(SETTLED_CAPTURE_WAIT_MS, 2000);
  const clock = makeClock();
  let captureCount = 0;
  const buffer = await captureWhenSettled({
    isSettling: () => true,
    capture: async () => { captureCount += 1; return null; },
    now: clock.now, wait: clock.wait,
  });
  assert.equal(buffer, null);
  assert.equal(captureCount, 1);
  assert.equal(clock.now(), SETTLED_CAPTURE_WAIT_MS);
});

test('상한을 넘겨 기다리지 않는다(남은 시간만큼만 기다린다)', async () => {
  const clock = makeClock();
  await captureWhenSettled({
    isSettling: () => true, capture: async () => null, now: clock.now, wait: clock.wait, maxWaitMs: 250, pollMs: 100,
  });
  assert.deepEqual(clock.waitList, [100, 100, 50]);
});

test('질문·명령·지시 해설·전환 고지 캡처는 자리 잡기를 기다리고, 무음 해설은 기다리지 않고 건너뛴다', () => {
  const source = readSource('src/renderer/app/main.js');
  const readBody = (name) => {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}\n', start));
  };
  assert.match(source, /captureWhenSettled\(\{\s*isSettling: \(\) => roiStore\.isLayoutSettling\(\),\s*capture: \(\) => captureFrameJpeg\(\),\s*\}\)/);
  assert.match(source, /captureWhenSettled\(\{\s*isSettling: \(\) => roiStore\.isLayoutSettling\(\),\s*capture: \(\) => captureDeixisFrameSet\(/);
  assert.match(readBody('requestAnswer'), /await captureFrameJpegWhenSettled\(\);/);
  assert.match(readBody('runDeixisDecision'), /captureDeixisFrameSetWhenSettled\(firedDecision\.region\)/);
  assert.match(readBody('requestPageTransitionNarration'), /await captureFrameJpegWhenSettled\(\);/);
  assert.doesNotMatch(readBody('handleSilenceTrigger'), /WhenSettled/);
});
