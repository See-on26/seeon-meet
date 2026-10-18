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
    id: '1|빨간 막대는 재구매율 30%', type: 'interpretation', badge: '발화 기반', text: '빨간 막대는 재구매율 30%',
    rationaleText: '발화 "30%예요" · 근거 표현=30%', wallMs: 99,
  });
  assert.equal(buildDemoCard({ playback: { ts: 2, text: '슬라이드 3', source: 'page-transition' } }).badge, '페이지 전환');
  assert.equal(buildDemoCard({ playback: { ts: 3, text: '답', source: 'user_command' } }).badge, '질문 답');
  assert.equal(buildDemoCard({ playback: { ts: 4, text: 'x', source: null } }).rationaleText, '');
});

// QA 2-3: 시연 배지도 viewer 카드와 같은 아키텍처 기준(재생 분류) 이름이다.
test('시연 배지는 재생 분류 기준이라 같은 시각 묘사도 발화 기반·무발화 기반·페이지 전환으로 나뉜다', () => {
  const badgeOf = (narrationClass, source) => buildDemoCard({ playback: { ts: 1, text: 'x', source, narrationClass }, caption: { source, narrationClass } }).badge;
  assert.equal(badgeOf('speech_based', 'visual_description'), '발화 기반');
  assert.equal(badgeOf('silence_based', 'visual_description'), '무발화 기반');
  assert.equal(badgeOf('page_transition', 'visual_description'), '페이지 전환');
  assert.equal(badgeOf('speaker_identity', 'speaker_identity'), '화자 식별');
  assert.equal(badgeOf(undefined, 'visual_description'), '화면 해설', '분류 없는 시각 묘사는 경로를 몰라 기본 배지');
});

test('키는 자판 위치로 읽는다: G 근거, +/− 글자 크기, C 지우기', () => {
  assert.equal(readKeyAction({ code: 'KeyG' }), DEMO_ACTION_MAP.toggleRationale);
  assert.equal(readKeyAction({ code: 'Equal' }), DEMO_ACTION_MAP.fontUp);
  assert.equal(readKeyAction({ code: 'NumpadSubtract' }), DEMO_ACTION_MAP.fontDown);
  assert.equal(readKeyAction({ code: 'KeyC' }), DEMO_ACTION_MAP.clear);
  assert.equal(readKeyAction({ code: 'KeyX' }), null);
});

test('⌘·Ctrl·Option 을 함께 누른 키는 시연 단축키로 읽지 않는다(⌘C 복사·⌘= 확대는 그대로)', () => {
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) {
    for (const code of ['KeyC', 'KeyG', 'Equal', 'Minus', 'NumpadAdd']) {
      assert.equal(readKeyAction({ code, [modifier]: true }), null, `${modifier}+${code}`);
    }
  }
  assert.equal(readKeyAction({ code: 'Equal', shiftKey: true }), DEMO_ACTION_MAP.fontUp, 'Shift+= 은 + 이므로 크게');
});

function installFakeDemoPage() {
  const page = { keydownList: [], cardCallback: null, renderedCountList: [], fontSizeList: [] };
  const makeElement = () => ({ className: '', textContent: '', append() {} });
  globalThis.document = {
    getElementById: () => ({ replaceChildren: (...childList) => page.renderedCountList.push(childList.length), scrollTop: 0, scrollHeight: 0 }),
    createElement: makeElement,
    documentElement: { style: { setProperty: (_name, value) => page.fontSizeList.push(value) } },
    body: { classList: { toggle() {} } },
  };
  globalThis.window = {
    labDemo: { onCard: (callback) => { page.cardCallback = callback; } },
    addEventListener: (type, listener) => { if (type === 'keydown') page.keydownList.push(listener); },
  };
  page.press = (eventPatch) => {
    let isPrevented = false;
    for (const listener of page.keydownList) listener({ preventDefault: () => { isPrevented = true; }, ...eventPatch });
    return isPrevented;
  };
  return page;
}

test('시연 창은 ⌘C·⌘=·⌘− 를 가로채지 않아 카드·글자 크기가 그대로이고, 수식키 없는 C 만 카드를 지운다', async () => {
  const page = installFakeDemoPage();
  try {
    await import(`../src/renderer/lab/demo.js?modifier-test=${Date.now()}`);
    page.cardCallback({ id: 'a', badge: '지시', text: '해설', rationaleText: '' });
    assert.equal(page.renderedCountList.at(-1), 1);
    assert.equal(page.press({ code: 'KeyC', metaKey: true }), false, '⌘C 는 복사로 둔다');
    assert.equal(page.press({ code: 'Equal', metaKey: true }), false);
    assert.equal(page.press({ code: 'Minus', ctrlKey: true }), false);
    assert.equal(page.renderedCountList.at(-1), 1, '카드가 지워지지 않았다');
    assert.deepEqual([...new Set(page.fontSizeList)], [`${DEMO_FONT_SIZE_MAP.initial}px`], '글자 크기가 그대로다');
    assert.equal(page.press({ code: 'KeyC' }), true);
    assert.equal(page.renderedCountList.at(-1), 0);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
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
