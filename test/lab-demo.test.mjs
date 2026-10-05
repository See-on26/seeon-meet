import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createDemoState, reduceDemoState, readKeyAction, DEMO_ACTION_MAP, DEMO_FONT_SIZE_MAP, MAX_CARD_COUNT,
} from '../src/renderer/lab/demo/demo-state.js';

const require = createRequire(import.meta.url);
const { buildDemoCard } = require('../src/main/lab/demo-card.js');

test('시연 카드는 분류 배지·해설 문장·근거(발화와 근거 표현)다', () => {
  assert.deepEqual(buildDemoCard({
    playback: { ts: 1, text: '빨간 막대는 재구매율 30%', source: 'interpretation', wallMs: 99 },
    caption: { source: 'interpretation', rationale: { utterance: '30%예요', summary: '근거 표현=30%' } },
  }), {
    id: '1|빨간 막대는 재구매율 30%', type: 'interpretation', badge: '수치 의미', text: '빨간 막대는 재구매율 30%',
    rationaleText: '발화 "30%예요" · 근거 표현=30%', wallMs: 99,
  });
  assert.equal(buildDemoCard({ playback: { ts: 2, text: '슬라이드 3', source: 'page-transition' } }).badge, '페이지 전환');
  assert.equal(buildDemoCard({ playback: { ts: 3, text: '답', source: 'user_command' } }).badge, '질문 답');
  assert.equal(buildDemoCard({ playback: { ts: 4, text: 'x', source: null } }).rationaleText, '');
});

test('키는 자판 위치로 읽는다: G 근거, +/− 글자 크기, C 지우기', () => {
  assert.equal(readKeyAction({ code: 'KeyG' }), DEMO_ACTION_MAP.toggleRationale);
  assert.equal(readKeyAction({ code: 'Equal' }), DEMO_ACTION_MAP.fontUp);
  assert.equal(readKeyAction({ code: 'NumpadSubtract' }), DEMO_ACTION_MAP.fontDown);
  assert.equal(readKeyAction({ code: 'KeyC' }), DEMO_ACTION_MAP.clear);
  assert.equal(readKeyAction({ code: 'KeyX' }), null);
});

test('카드는 들린 순서로 쌓이고 같은 카드는 한 번만, 최대 개수를 넘으면 오래된 것부터 뺀다', () => {
  let state = createDemoState();
  state = reduceDemoState(state, { type: DEMO_ACTION_MAP.card, card: { id: 'a' } });
  state = reduceDemoState(state, { type: DEMO_ACTION_MAP.card, card: { id: 'a' } });
  state = reduceDemoState(state, { type: DEMO_ACTION_MAP.card, card: { id: 'b' } });
  assert.deepEqual(state.cardList.map((card) => card.id), ['a', 'b']);
  for (let index = 0; index < MAX_CARD_COUNT + 5; index += 1) {
    state = reduceDemoState(state, { type: DEMO_ACTION_MAP.card, card: { id: `n${index}` } });
  }
  assert.equal(state.cardList.length, MAX_CARD_COUNT);
  assert.equal(reduceDemoState(state, { type: DEMO_ACTION_MAP.clear }).cardList.length, 0);
});

test('근거 표시는 켜고 끄며 글자 크기는 범위 안에서만 바뀐다', () => {
  let state = createDemoState();
  state = reduceDemoState(state, { type: DEMO_ACTION_MAP.toggleRationale });
  assert.equal(state.isRationaleVisible, true);
  for (let index = 0; index < 30; index += 1) state = reduceDemoState(state, { type: DEMO_ACTION_MAP.fontUp });
  assert.equal(state.fontSizePx, DEMO_FONT_SIZE_MAP.max);
  for (let index = 0; index < 30; index += 1) state = reduceDemoState(state, { type: DEMO_ACTION_MAP.fontDown });
  assert.equal(state.fontSizePx, DEMO_FONT_SIZE_MAP.min);
});
