import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isPlayheadInSilence, waitForPlayheadSilence, shouldWaitForInsertGap, INSERT_GAP_MAX_WAIT_MS,
} from '../src/renderer/core/audio-renderer/insert-gap-wait.js';

const spanList = [{ startMs: 1000, endMs: 1600, isOpen: false }, { startMs: 3000, endMs: 3400, isOpen: true }];

test('재생 위치가 잰 무음 안(시작 뒤 0.1초부터, 끝 0.1초 전까지)이면 말 틈으로 본다', () => {
  assert.equal(isPlayheadInSilence({ playheadMs: 1100, spanList }), true);
  assert.equal(isPlayheadInSilence({ playheadMs: 1500, spanList }), true);
  assert.equal(isPlayheadInSilence({ playheadMs: 3200, spanList }), true);
});

test('무음 바로 앞·무음 시작 직후·끝나기 직전·무음 밖은 말 틈으로 보지 않는다', () => {
  assert.equal(isPlayheadInSilence({ playheadMs: 950, spanList }), false);
  assert.equal(isPlayheadInSilence({ playheadMs: 1050, spanList }), false);
  assert.equal(isPlayheadInSilence({ playheadMs: 1550, spanList }), false);
  assert.equal(isPlayheadInSilence({ playheadMs: 2000, spanList }), false);
  assert.equal(isPlayheadInSilence({ playheadMs: Number.NaN, spanList }), false);
});

test('지연 버퍼 목표 지연이 0인 성능 모드에서만 말 틈을 기다린다', () => {
  assert.equal(shouldWaitForInsertGap({ hasDelayBuffer: true, delayMs: 0 }), true);
  assert.equal(shouldWaitForInsertGap({ hasDelayBuffer: true, delayMs: 10000 }), false);
  assert.equal(shouldWaitForInsertGap({ hasDelayBuffer: false, delayMs: 0 }), false);
});

function createClock() {
  const clock = { nowMs: 0, sleepList: [] };
  clock.now = () => clock.nowMs;
  clock.sleep = async (ms) => { clock.sleepList.push(ms); clock.nowMs += ms; };
  return clock;
}

test('이미 말 틈이면 기다리지 않고 바로 돌아온다', async () => {
  const clock = createClock();
  const result = await waitForPlayheadSilence({ isInSilence: () => true, now: clock.now, sleep: clock.sleep });
  assert.deepEqual(result, { isSilence: true, waitedMs: 0 });
  assert.deepEqual(clock.sleepList, []);
});

test('말 틈이 올 때까지 0.05초마다 다시 본다', async () => {
  const clock = createClock();
  const result = await waitForPlayheadSilence({ isInSilence: () => clock.nowMs >= 400, now: clock.now, sleep: clock.sleep });
  assert.deepEqual(result, { isSilence: true, waitedMs: 400 });
  assert.ok(clock.sleepList.every((ms) => ms === 50));
});

test('1.5초 안에 말 틈이 없으면 기다리기를 그만둔다', async () => {
  const clock = createClock();
  const result = await waitForPlayheadSilence({ isInSilence: () => false, now: clock.now, sleep: clock.sleep });
  assert.equal(INSERT_GAP_MAX_WAIT_MS, 1500);
  assert.deepEqual(result, { isSilence: false, waitedMs: 1500 });
});

test('앱은 교차 모드 재생기에 말 틈 기다리기를 넘기고, 성능 모드일 때만 잰 무음으로 기다린다', () => {
  const mainSource = fs.readFileSync(new URL('../src/renderer/app/main.js', import.meta.url), 'utf8');
  const narratorBlock = mainSource.slice(mainSource.indexOf('new CaptionNarrator({'), mainSource.indexOf('let narrationMixer'));
  assert.match(narratorBlock, /\n  waitForInsertGap,\n/);
  const waitBlock = mainSource.slice(mainSource.indexOf('async function waitForInsertGap()'));
  assert.match(waitBlock, /shouldWaitForInsertGap\(\{ hasDelayBuffer: Boolean\(delayBuffer\), delayMs: delayBuffer\?\.targetDelayMs \?\? 0 \}\)/);
  assert.match(waitBlock, /playheadMs: delayBuffer\.getDelayedTimeMs\(\), spanList: silenceSpanTracker\.getSpanList\(\)/);
});
