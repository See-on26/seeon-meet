import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createFeatureToggleStore, FEATURE_KEY_LIST, FEATURE_KEY_MAP, FEATURE_TOGGLE_STORAGE_KEY,
  readFeatureKeyFromDigit, listDisabledNarrationClass,
} from '../src/renderer/core/mode/feature-toggle-store.js';
import { NarrationQueue, QUEUE_DROP_REASON_MAP } from '../src/renderer/core/audio-renderer/narration-queue.js';

const require = createRequire(import.meta.url);
const { readFeatureToggleDigit, readCommandFromInput, isSummaryToggleInput } = require('../src/main/shortcut.js');
const { createFeatureGate } = require('../src/main/caption-pipeline/orchestrator/feature-gate.js');
const { selectGeneratableCandidate } = require('../src/main/caption-pipeline/orchestrator/candidate-selector.js');

function createMemoryStorage(initialMap = {}) {
  const map = new Map(Object.entries(initialMap));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    map,
  };
}

test('기능 토글은 7개이고 단축키 숫자 1~7 순서와 같다', () => {
  assert.deepEqual(FEATURE_KEY_LIST, [
    'page_transition', 'deixis', 'speech_based', 'silence_based', 'speaker_identity',
    'manual_question', 'meeting_summary',
  ]);
  assert.equal(readFeatureKeyFromDigit('1'), FEATURE_KEY_MAP.pageTransition);
  assert.equal(readFeatureKeyFromDigit('7'), FEATURE_KEY_MAP.meetingSummary);
  assert.equal(readFeatureKeyFromDigit('8'), null);
  assert.equal(readFeatureKeyFromDigit('0'), null);
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
  assert.equal(broken.isOn(FEATURE_KEY_MAP.deixis), true);

  const odd = createFeatureToggleStore({ storage: createMemoryStorage({
    [FEATURE_TOGGLE_STORAGE_KEY]: JSON.stringify({ deixis: 'no', unknown_key: false, silence_based: false }),
  }) });
  assert.equal(odd.isOn(FEATURE_KEY_MAP.deixis), true);
  assert.equal(odd.isOn(FEATURE_KEY_MAP.silenceBased), false);
  assert.equal(odd.isOn('unknown_key'), false);
});

test('저장소가 없거나 쓰기에 실패해도 메모리 상태로 동작한다', () => {
  const store = createFeatureToggleStore({ storage: null });
  assert.equal(store.toggle(FEATURE_KEY_MAP.deixis), false);
  const failing = createFeatureToggleStore({ storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } } });
  assert.equal(failing.toggle(FEATURE_KEY_MAP.deixis), false);
  assert.equal(failing.isOn(FEATURE_KEY_MAP.deixis), false);
});

test('바뀔 때마다 구독자에게 키와 상태를 알린다', () => {
  const store = createFeatureToggleStore({ storage: createMemoryStorage() });
  const changeList = [];
  store.subscribe((change) => changeList.push(change));
  store.toggle(FEATURE_KEY_MAP.silenceBased);
  store.set(FEATURE_KEY_MAP.silenceBased, false);
  store.set(FEATURE_KEY_MAP.silenceBased, true);
  assert.deepEqual(changeList, [
    { key: 'silence_based', isOn: false },
    { key: 'silence_based', isOn: true },
  ]);
});

test('꺼진 기능을 재생 분류로 바꾼다 — 질문은 user_command, 요약은 해설이 아니다', () => {
  const store = createFeatureToggleStore({ storage: createMemoryStorage() });
  store.set(FEATURE_KEY_MAP.pageTransition, false);
  store.set(FEATURE_KEY_MAP.manualQuestion, false);
  store.set(FEATURE_KEY_MAP.meetingSummary, false);
  assert.deepEqual(listDisabledNarrationClass({ store }), ['page_transition', 'user_command']);
  assert.equal(store.isClassOn('page_transition'), false);
  assert.equal(store.isClassOn('user_command'), false);
  assert.equal(store.isClassOn('deixis'), true);
  assert.equal(store.isClassOn(undefined), true);
});

test('Ctrl/Cmd+Shift+1~7 은 기능 토글 단축키다', () => {
  const base = { type: 'keyDown', control: true, shift: true };
  assert.equal(readFeatureToggleDigit({ input: { ...base, key: '!', code: 'Digit1' } }), '1');
  assert.equal(readFeatureToggleDigit({ input: { ...base, key: '&', code: 'Digit7' } }), '7');
  assert.equal(readFeatureToggleDigit({ input: { ...base, control: false, meta: true, key: '#', code: 'Digit3' } }), '3');
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

const deixis = { type: 'deixis', subKind: 'simple', anchor: '이거', ts: 1 };
const valueToMeaning = { type: 'interpretation', subKind: 'value_to_meaning', anchor: '30%', ts: 1 };

test('발화 기반을 끄면 값·의미 후보를 생성 전에 빼고 지시 후보가 남는다', () => {
  const { selected } = selectGeneratableCandidate({
    candidateList: [valueToMeaning, deixis], disabledClassList: ['speech_based'],
  });
  assert.equal(selected.type, 'deixis');
  assert.deepEqual(selected.mergedAnchorList, undefined);
});

test('지시를 끄면 지시 후보만 남은 발화는 고르지 않는다', () => {
  const { selected } = selectGeneratableCandidate({ candidateList: [deixis], disabledClassList: ['deixis'] });
  assert.equal(selected, null);
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
