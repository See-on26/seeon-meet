import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createFeatureToggleStore, FEATURE_KEY_LIST, FEATURE_KEY_MAP, FEATURE_TOGGLE_STORAGE_KEY,
  readFeatureKeyFromDigit, listDisabledNarrationClass, listDisabledFeatureLabel, isFeatureLockedDuringCapture,
} from '../src/renderer/core/mode/feature-toggle-store.js';
import { NarrationQueue, QUEUE_DROP_REASON_MAP } from '../src/renderer/core/audio-renderer/narration-queue.js';

const require = createRequire(import.meta.url);
const { readFeatureToggleDigit, readCommandFromInput, isSummaryToggleInput } = require('../src/main/shortcut.js');
const { createFeatureGate } = require('../src/main/caption-pipeline/orchestrator/feature-gate.js');

function createMemoryStorage(initialMap = {}) {
  const map = new Map(Object.entries(initialMap));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    map,
  };
}

test('켜고 끄는 기능은 부가 정보 2종(페이지 전환·화자)과 회의 요약이고 단축키 숫자 1~3 순서와 같다', () => {
  assert.deepEqual(FEATURE_KEY_LIST, ['page_transition', 'speaker_identity', 'meeting_summary']);
  assert.equal(readFeatureKeyFromDigit('1'), FEATURE_KEY_MAP.pageTransition);
  assert.equal(readFeatureKeyFromDigit('2'), FEATURE_KEY_MAP.speakerIdentity);
  assert.equal(readFeatureKeyFromDigit('3'), FEATURE_KEY_MAP.meetingSummary);
  assert.equal(readFeatureKeyFromDigit('4'), null);
  assert.equal(readFeatureKeyFromDigit('0'), null);
});

test('정보 공백 해설(지시·발화·무발화)과 질문은 끌 수 없다', () => {
  for (const key of ['deixis', 'speech_based', 'silence_based', 'manual_question']) {
    assert.equal(FEATURE_KEY_LIST.includes(key), false, key);
  }
  const store = createFeatureToggleStore({ storage: createMemoryStorage() });
  for (const narrationClass of ['deixis', 'speech_based', 'silence_based', 'user_command']) {
    assert.equal(store.isClassOn(narrationClass), true, narrationClass);
  }
});

test('화자 안내만 회의 캡처 중에는 바꿀 수 없다', () => {
  assert.equal(isFeatureLockedDuringCapture(FEATURE_KEY_MAP.speakerIdentity), true);
  assert.equal(isFeatureLockedDuringCapture(FEATURE_KEY_MAP.pageTransition), false);
  assert.equal(isFeatureLockedDuringCapture(FEATURE_KEY_MAP.meetingSummary), false);
});

test('저장된 값이 없으면 전부 켜짐으로 시작한다', () => {
  const store = createFeatureToggleStore({ storage: createMemoryStorage() });
  for (const key of FEATURE_KEY_LIST) assert.equal(store.isOn(key), true, key);
});

test('바꾼 값은 저장소에 남아 다음 실행에도 유지된다', () => {
  const storage = createMemoryStorage();
  const store = createFeatureToggleStore({ storage });
  assert.equal(store.toggle(FEATURE_KEY_MAP.speakerIdentity), false);
  store.set(FEATURE_KEY_MAP.meetingSummary, false);

  const reloaded = createFeatureToggleStore({ storage });
  assert.equal(reloaded.isOn(FEATURE_KEY_MAP.speakerIdentity), false);
  assert.equal(reloaded.isOn(FEATURE_KEY_MAP.meetingSummary), false);
  assert.equal(reloaded.isOn(FEATURE_KEY_MAP.pageTransition), true);
});

test('저장 값이 깨졌거나 모르는 키가 있으면 무시하고 켜짐으로 본다', () => {
  const broken = createFeatureToggleStore({ storage: createMemoryStorage({ [FEATURE_TOGGLE_STORAGE_KEY]: '{not json' }) });
  assert.equal(broken.isOn(FEATURE_KEY_MAP.pageTransition), true);

  // 예전 7개 토글 시절에 저장된 deixis·silence_based 같은 키는 무시한다.
  const odd = createFeatureToggleStore({ storage: createMemoryStorage({
    [FEATURE_TOGGLE_STORAGE_KEY]: JSON.stringify({ page_transition: 'no', deixis: false, speaker_identity: false }),
  }) });
  assert.equal(odd.isOn(FEATURE_KEY_MAP.pageTransition), true);
  assert.equal(odd.isOn(FEATURE_KEY_MAP.speakerIdentity), false);
  assert.equal(odd.isClassOn('deixis'), true);
});

test('저장소가 없거나 쓰기에 실패해도 메모리 상태로 동작한다', () => {
  const store = createFeatureToggleStore({ storage: null });
  assert.equal(store.toggle(FEATURE_KEY_MAP.pageTransition), false);
  const failing = createFeatureToggleStore({ storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } } });
  assert.equal(failing.toggle(FEATURE_KEY_MAP.pageTransition), false);
  assert.equal(failing.isOn(FEATURE_KEY_MAP.pageTransition), false);
});

test('바뀔 때마다 구독자에게 키와 상태를 알린다', () => {
  const store = createFeatureToggleStore({ storage: createMemoryStorage() });
  const changeList = [];
  store.subscribe((change) => changeList.push(change));
  store.toggle(FEATURE_KEY_MAP.pageTransition);
  store.set(FEATURE_KEY_MAP.pageTransition, false);
  store.set(FEATURE_KEY_MAP.pageTransition, true);
  assert.deepEqual(changeList, [
    { key: 'page_transition', isOn: false },
    { key: 'page_transition', isOn: true },
  ]);
});

test('꺼진 기능을 재생 분류로 바꾼다 — 요약은 해설이 아니다', () => {
  const store = createFeatureToggleStore({ storage: createMemoryStorage() });
  store.set(FEATURE_KEY_MAP.pageTransition, false);
  store.set(FEATURE_KEY_MAP.speakerIdentity, false);
  store.set(FEATURE_KEY_MAP.meetingSummary, false);
  assert.deepEqual(listDisabledNarrationClass({ store }), ['page_transition', 'speaker_identity']);
  assert.equal(store.isClassOn('page_transition'), false);
  assert.equal(store.isClassOn('speaker_identity'), false);
  assert.equal(store.isClassOn('deixis'), true);
  assert.equal(store.isClassOn(undefined), true);
});

test('Ctrl/Cmd+Shift+1~3 은 기능 토글 단축키다', () => {
  const base = { type: 'keyDown', control: true, shift: true };
  assert.equal(readFeatureToggleDigit({ input: { ...base, key: '!', code: 'Digit1' } }), '1');
  assert.equal(readFeatureToggleDigit({ input: { ...base, key: '#', code: 'Digit3' } }), '3');
  assert.equal(readFeatureToggleDigit({ input: { ...base, key: '$', code: 'Digit4' } }), null);
  // 맥에서 Cmd+Shift+3/4/5 는 OS 스크린샷이 먼저 가져가므로 안내는 Control 로 한다. Cmd 도 받기는 한다.
  assert.equal(readFeatureToggleDigit({ input: { ...base, control: false, meta: true, key: '@', code: 'Digit2' } }), '2');
  assert.equal(readFeatureToggleDigit({ input: { ...base, key: '*', code: 'Digit8' } }), null);
  assert.equal(readFeatureToggleDigit({ input: { ...base, key: ')', code: 'Digit0' } }), null);
  assert.equal(readFeatureToggleDigit({ input: { ...base, shift: false, key: '1', code: 'Digit1' } }), null);
  assert.equal(readFeatureToggleDigit({ input: { ...base, alt: true, key: '1', code: 'Digit1' } }), null);
  assert.equal(readFeatureToggleDigit({ input: { ...base, isAutoRepeat: true, key: '!', code: 'Digit1' } }), null);
  assert.equal(readFeatureToggleDigit({ input: { ...base, type: 'keyUp', key: '!', code: 'Digit1' } }), null);
});

test('기능 토글 단축키는 기존 Ctrl+5~7·Ctrl+0 과 겹치지 않는다', () => {
  const input = { type: 'keyDown', control: true, shift: true, key: '%', code: 'Digit5' };
  assert.equal(readCommandFromInput({ input }), null);
  assert.equal(isSummaryToggleInput({ input: { ...input, key: ')', code: 'Digit0' } }), false);
});

test('main 기능 게이트는 알려진 분류만 받아 꺼짐 여부를 답한다', () => {
  const gate = createFeatureGate();
  assert.equal(gate.isEnabled('page_transition'), true);
  gate.setDisabledClassList(['page_transition', 'bogus', 'user_command']);
  assert.equal(gate.isEnabled('page_transition'), false);
  assert.equal(gate.isEnabled('user_command'), false);
  assert.equal(gate.isEnabled('deixis'), true);
  assert.deepEqual(gate.getDisabledClassList(), ['page_transition', 'user_command']);
  gate.setDisabledClassList(null);
  assert.equal(gate.isEnabled('page_transition'), true);
});

test('재생 대기 줄은 꺼진 분류의 해설을 꺼내지 않고 기능 꺼짐으로 버린다', () => {
  const disabledSet = new Set(['speaker_identity']);
  const queue = new NarrationQueue({ now: () => 0, isEntryEnabled: (entry) => !disabledSet.has(entry.narrationClass) });
  queue.push({ text: '화자', narrationClass: 'speaker_identity' });
  queue.push({ text: '지시', narrationClass: 'deixis' });
  const { entry, droppedList } = queue.takeNext();
  assert.equal(entry.text, '지시');
  assert.deepEqual(droppedList.map((drop) => [drop.entry.text, drop.reason]), [['화자', QUEUE_DROP_REASON_MAP.featureOff]]);
});

test('main 기능 게이트는 꺼졌다가 다시 켜진 분류를 알려 준다', () => {
  const gate = createFeatureGate();
  assert.deepEqual(gate.setDisabledClassList(['speaker_identity', 'deixis']), { reenabledClassList: [] });
  assert.deepEqual(gate.setDisabledClassList(['deixis']), { reenabledClassList: ['speaker_identity'] });
  assert.deepEqual(gate.setDisabledClassList([]), { reenabledClassList: ['deixis'] });
});

test('꺼진 기능 이름을 설정 순서대로 돌려준다 — 캡처 시작 때 안내용', () => {
  const store = createFeatureToggleStore({ storage: createMemoryStorage() });
  assert.deepEqual(listDisabledFeatureLabel({ store }), []);
  store.set(FEATURE_KEY_MAP.meetingSummary, false);
  store.set(FEATURE_KEY_MAP.pageTransition, false);
  assert.deepEqual(listDisabledFeatureLabel({ store }), ['페이지 전환 안내', '회의 요약']);
});
