import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readPipelineConfig, SCREEN_CHANGE_MODE_MAP } = require('../src/main/caption-pipeline/config.js');

function withWarnList(run) {
  const warnList = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnList.push(String(message));
  try {
    return { result: run(), warnList };
  } finally {
    console.warn = originalWarn;
  }
}

test('SEEON_SCREEN_CHANGE 가 없으면 꺼짐(off)이고 나머지는 설계 기본값이다', () => {
  const config = readPipelineConfig({});
  assert.equal(config.screenChangeMode, SCREEN_CHANGE_MODE_MAP.off);
  assert.equal(config.screenChangeMinIntervalMs, 20000);
  assert.equal(config.screenChangePerSlideMax, 2);
  assert.deepEqual(config.screenChangeKindList, ['new_text', 'highlight']);
  assert.equal(config.screenChangeImage, 'outline');
});

test('shadow·same_slide 는 그대로 받는다', () => {
  assert.equal(readPipelineConfig({ SEEON_SCREEN_CHANGE: 'shadow' }).screenChangeMode, 'shadow');
  assert.equal(readPipelineConfig({ SEEON_SCREEN_CHANGE: 'same_slide' }).screenChangeMode, 'same_slide');
});

test('모르는 값은 경고하고 꺼짐으로 둔다', () => {
  const { result, warnList } = withWarnList(() => readPipelineConfig({ SEEON_SCREEN_CHANGE: 'bogus' }));
  assert.equal(result.screenChangeMode, 'off');
  assert.ok(warnList.some((message) => message.includes('SEEON_SCREEN_CHANGE')));
});

test('all 은 새 슬라이드 값 한 줄이 아직 없어 경고하고 same_slide 로 돈다 — 기록에도 same_slide', () => {
  const { result, warnList } = withWarnList(() => readPipelineConfig({ SEEON_SCREEN_CHANGE: 'all' }));
  assert.equal(result.screenChangeMode, 'same_slide');
  assert.ok(warnList.some((message) => message.includes('same_slide')));
});

test('간격·슬라이드당 상한은 양의 정수만 받고, 아니면 경고하고 기본값이다', () => {
  const config = readPipelineConfig({ SEEON_SCREEN_CHANGE_MIN_INTERVAL_MS: '30000', SEEON_SCREEN_CHANGE_PER_SLIDE_MAX: '3' });
  assert.equal(config.screenChangeMinIntervalMs, 30000);
  assert.equal(config.screenChangePerSlideMax, 3);
  const { result } = withWarnList(() => readPipelineConfig({
    SEEON_SCREEN_CHANGE_MIN_INTERVAL_MS: '-5', SEEON_SCREEN_CHANGE_PER_SLIDE_MAX: 'two',
  }));
  assert.equal(result.screenChangeMinIntervalMs, 20000);
  assert.equal(result.screenChangePerSlideMax, 2);
});

test('사건 종류 목록은 아는 것만 받고, 하나도 없으면 기본 목록이다', () => {
  assert.deepEqual(readPipelineConfig({ SEEON_SCREEN_CHANGE_KINDS: 'new_text, visual' }).screenChangeKindList, ['new_text', 'visual']);
  const { result } = withWarnList(() => readPipelineConfig({ SEEON_SCREEN_CHANGE_KINDS: 'new_slide,wrong' }));
  assert.deepEqual(result.screenChangeKindList, ['new_text', 'highlight']);
});

test('VLM 그림은 outline·crop·full 만 받는다', () => {
  assert.equal(readPipelineConfig({ SEEON_SCREEN_CHANGE_IMAGE: 'crop' }).screenChangeImage, 'crop');
  const { result } = withWarnList(() => readPipelineConfig({ SEEON_SCREEN_CHANGE_IMAGE: 'zoom' }));
  assert.equal(result.screenChangeImage, 'outline');
});
