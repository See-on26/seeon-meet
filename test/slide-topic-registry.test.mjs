import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createSlideTopicRegistry, SLIDE_TOPIC_VERDICT_MAP,
} = require('../src/main/caption-pipeline/orchestrator/slide-topic-registry.js');

const DOC = { topic: '반기 연봉 조정 제도', description: '연봉 조정 제도를 설명하는 본문 문서' };
const SLIDE_A = { topic: '팀과 구성원의 Win-Win', description: '팀과 구성원이 함께 성장하는 그림' };
const SLIDE_B = { topic: '공정한 보상 원칙', description: '보상 원칙 세 가지를 나열한 표' };

test('슬라이드가 아닌 화면은 기록하되 번호를 주지 않아, 그 뒤 첫 슬라이드가 1번이 된다', () => {
  const registry = createSlideTopicRegistry();
  const docEntry = registry.remember({ ...DOC, isSlide: false });
  const slideEntry = registry.remember({ ...SLIDE_A, isSlide: true });
  assert.equal(registry.resolveDisplayNumber({ entry: docEntry }), null);
  assert.equal(registry.resolveDisplayNumber({ entry: slideEntry }), 1);
  assert.equal(registry.resolveDisplayNumber({ entry: registry.remember({ ...SLIDE_B, isSlide: true }) }), 2);
});

test('번호를 주지 않은 화면도 기록에 남아 다시 나오면 복귀로 알아본다', () => {
  const registry = createSlideTopicRegistry();
  registry.remember({ ...DOC, isSlide: false });
  registry.remember({ ...SLIDE_A, isSlide: true });
  assert.equal(registry.judge(DOC).kind, SLIDE_TOPIC_VERDICT_MAP.revisit);
});

test('주제를 못 읽은 슬라이드도 슬라이드 순번을 받고, 다음 슬라이드 번호가 이어진다', () => {
  const registry = createSlideTopicRegistry();
  const untitled = registry.remember({ topic: '', description: '', isSlide: true });
  assert.equal(registry.resolveDisplayNumber({ entry: untitled }), 1);
  assert.equal(registry.resolveDisplayNumber({ entry: registry.remember({ ...SLIDE_A, isSlide: true }) }), 2);
  assert.equal(registry.remember({ topic: '', description: '', isSlide: false }), null);
});

test('화면에 쪽번호가 보이면 순번보다 쪽번호를 쓴다', () => {
  const registry = createSlideTopicRegistry();
  const entry = registry.remember({ ...SLIDE_A, pageNumber: 7, isSlide: true });
  assert.equal(registry.resolveDisplayNumber({ entry }), 7);
});

test('같은 화면을 다시 기억해도 번호가 늘지 않고, 처음엔 슬라이드가 아니던 화면이 슬라이드로 판정되면 그때 번호를 받는다', () => {
  const registry = createSlideTopicRegistry();
  const first = registry.remember({ ...SLIDE_A, isSlide: true });
  assert.equal(registry.remember({ ...SLIDE_A, isSlide: true }), first);
  registry.remember({ ...DOC, isSlide: false });
  const docAsSlide = registry.remember({ ...DOC, isSlide: true });
  assert.equal(registry.resolveDisplayNumber({ entry: docAsSlide }), 2);
});

test('reset 하면 슬라이드 순번도 처음부터 센다', () => {
  const registry = createSlideTopicRegistry();
  registry.remember({ ...SLIDE_A, isSlide: true });
  registry.reset();
  assert.equal(registry.resolveDisplayNumber({ entry: registry.remember({ ...SLIDE_B, isSlide: true }) }), 1);
});
