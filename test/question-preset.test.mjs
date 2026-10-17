import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createQuestionPresetStore, DEFAULT_QUESTION_PRESET_TEXT_LIST, MAX_QUESTION_PRESET_COUNT, QUESTION_PRESET_STORAGE_KEY,
  readQuestionPresetSlotFromKey,
} from '../src/renderer/core/mode/question-preset-store.js';
import { USER_COMMAND_MAP } from '../src/renderer/core/constants.js';

const require = createRequire(import.meta.url);
const { readQuestionPresetSlot, isSummaryToggleInput } = require('../src/main/shortcut.js');

function createMemoryStorage(initialMap = {}) {
  const map = new Map(Object.entries(initialMap));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    map,
  };
}

const storedTextList = (storage) => JSON.parse(storage.map.get(QUESTION_PRESET_STORAGE_KEY));

test('Ctrl/Cmd+1~9 는 질문 프리셋 번호다', () => {
  for (let slot = 1; slot <= 9; slot += 1) {
    assert.equal(readQuestionPresetSlot({ input: { type: 'keyDown', key: String(slot), control: true } }), slot);
    assert.equal(readQuestionPresetSlot({ input: { type: 'keyDown', key: String(slot), meta: true } }), slot);
  }
  assert.equal(readQuestionPresetSlot({ input: { type: 'keyDown', key: '0', control: true } }), null);
  assert.equal(readQuestionPresetSlot({ input: { type: 'keyDown', key: '1' } }), null);
  assert.equal(readQuestionPresetSlot({ input: { type: 'keyUp', key: '1', control: true } }), null);
  assert.equal(readQuestionPresetSlot({ input: { type: 'keyDown', key: '!', control: true, shift: true } }), null);
  assert.equal(readQuestionPresetSlot({ input: { type: 'keyDown', key: '1', control: true, alt: true } }), null);
  assert.equal(readQuestionPresetSlot({ input: { type: 'keyDown', key: 'a', control: true } }), null);
});

test('키를 누르고 있어도 질문은 한 번만 보낸다', () => {
  assert.equal(readQuestionPresetSlot({ input: { type: 'keyDown', key: '1', control: true, isAutoRepeat: true } }), null);
});

test('Ctrl+0 은 프리셋이 아니라 회의 요약 켜기·끄기로 남는다', () => {
  const input = { type: 'keyDown', key: '0', control: true };
  assert.equal(readQuestionPresetSlot({ input }), null);
  assert.equal(isSummaryToggleInput({ input }), true);
});

test('렌더러도 숫자 키 1~9 만 프리셋 번호로 읽는다', () => {
  assert.equal(readQuestionPresetSlotFromKey('1'), 1);
  assert.equal(readQuestionPresetSlotFromKey('9'), 9);
  assert.equal(readQuestionPresetSlotFromKey('0'), null);
  assert.equal(readQuestionPresetSlotFromKey('q'), null);
  assert.equal(readQuestionPresetSlotFromKey(undefined), null);
});

// 기본 3개는 원래 빠른 질의 Ctrl+5·6·7 의 순서를 1·2·3 으로 옮긴 것이다.
test('저장된 값이 없으면 기본 프리셋 3개로 시작하고, 기본 문구는 전용 명령으로 답한다', () => {
  const store = createQuestionPresetStore({ storage: createMemoryStorage() });
  assert.equal(MAX_QUESTION_PRESET_COUNT, 9);
  assert.deepEqual(DEFAULT_QUESTION_PRESET_TEXT_LIST, ['무슨 자료야?', '지금 화면 요약', '그래프 축이 뭐야?']);
  assert.deepEqual(store.list(), [
    { slot: 1, text: '무슨 자료야?', command: USER_COMMAND_MAP.screenMaterial },
    { slot: 2, text: '지금 화면 요약', command: USER_COMMAND_MAP.pageSummary },
    { slot: 3, text: '그래프 축이 뭐야?', command: USER_COMMAND_MAP.graphAxis },
  ]);
  assert.equal(store.get(4), null);
  assert.equal(store.get(0), null);
});

test('문구를 고치면 자유 질문으로 답하고, 기본 문구로 되돌리면 다시 전용 명령이다', () => {
  const store = createQuestionPresetStore({ storage: createMemoryStorage() });
  store.setText(2, '  발표자가 지금 가리키는 게 뭐야? ');
  assert.deepEqual(store.get(2), { slot: 2, text: '발표자가 지금 가리키는 게 뭐야?', command: null });
  store.setText(2, '지금 화면 요약');
  assert.equal(store.get(2).command, USER_COMMAND_MAP.pageSummary);
});

test('9개까지 넣을 수 있고 그 뒤로는 넣지 않는다', () => {
  const store = createQuestionPresetStore({ storage: createMemoryStorage() });
  for (let index = 4; index <= 9; index += 1) assert.equal(store.add(`질문 ${index}`), true);
  assert.equal(store.list().length, 9);
  assert.equal(store.add('열 번째 질문'), false);
  assert.equal(store.list().length, 9);
  assert.equal(store.get(9).text, '질문 9');
});

test('빈 문구는 넣지 않고, 칸을 비우면 그 프리셋을 지워 뒤 번호가 당겨진다', () => {
  const store = createQuestionPresetStore({ storage: createMemoryStorage() });
  assert.equal(store.add('   '), false);
  store.setText(1, ' ');
  assert.deepEqual(store.list().map((preset) => preset.text), ['지금 화면 요약', '그래프 축이 뭐야?']);
  store.remove(1);
  assert.deepEqual(store.list(), [{ slot: 1, text: '그래프 축이 뭐야?', command: USER_COMMAND_MAP.graphAxis }]);
});

test('없는 번호를 고치거나 지워도 아무 일도 없다', () => {
  const store = createQuestionPresetStore({ storage: createMemoryStorage() });
  store.setText(7, '없는 칸');
  store.remove(0);
  store.remove(8);
  assert.equal(store.list().length, 3);
});

test('바꾼 프리셋은 저장소에 남아 다음 실행에도 유지되고, 기본값으로 되돌릴 수 있다', () => {
  const storage = createMemoryStorage();
  const store = createQuestionPresetStore({ storage });
  store.add('발표자 이름이 뭐야?');
  store.remove(3);
  assert.deepEqual(storedTextList(storage), ['무슨 자료야?', '지금 화면 요약', '발표자 이름이 뭐야?']);
  const reloaded = createQuestionPresetStore({ storage });
  assert.deepEqual(reloaded.list().map((preset) => preset.text), ['무슨 자료야?', '지금 화면 요약', '발표자 이름이 뭐야?']);
  reloaded.resetToDefault();
  assert.deepEqual(reloaded.list().map((preset) => preset.text), DEFAULT_QUESTION_PRESET_TEXT_LIST);
  assert.deepEqual(storedTextList(storage), DEFAULT_QUESTION_PRESET_TEXT_LIST);
});

test('모두 지운 상태도 다음 실행에 그대로 남는다', () => {
  const storage = createMemoryStorage();
  const store = createQuestionPresetStore({ storage });
  for (let count = 0; count < 3; count += 1) store.remove(1);
  assert.deepEqual(createQuestionPresetStore({ storage }).list(), []);
});

test('저장 값이 깨졌으면 기본값으로, 문자열이 아닌 칸·빈 칸·9개 넘는 칸은 버린다', () => {
  for (const broken of ['{', '"질문"', '{"a":1}', 'null']) {
    const store = createQuestionPresetStore({ storage: createMemoryStorage({ [QUESTION_PRESET_STORAGE_KEY]: broken }) });
    assert.deepEqual(store.list().map((preset) => preset.text), DEFAULT_QUESTION_PRESET_TEXT_LIST, broken);
  }
  const messy = JSON.stringify(['  첫 질문 ', 3, '', null, ...Array.from({ length: 10 }, (_, index) => `질문 ${index}`)]);
  const store = createQuestionPresetStore({ storage: createMemoryStorage({ [QUESTION_PRESET_STORAGE_KEY]: messy }) });
  assert.equal(store.list().length, 9);
  assert.equal(store.get(1).text, '첫 질문');
  assert.equal(store.get(2).text, '질문 0');
});

test('저장소가 없거나 쓰기에 실패해도 메모리 상태로 동작한다', () => {
  const noStorage = createQuestionPresetStore({ storage: null });
  noStorage.add('질문');
  assert.equal(noStorage.get(4).text, '질문');
  const failing = createQuestionPresetStore({
    storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } },
  });
  failing.setText(1, '바꾼 질문');
  assert.equal(failing.get(1).text, '바꾼 질문');
});

test('바뀔 때마다 구독자에게 새 목록을 알리고, 그대로면 알리지 않는다', () => {
  const store = createQuestionPresetStore({ storage: createMemoryStorage() });
  const countList = [];
  store.subscribe(({ presetList }) => countList.push(presetList.length));
  store.add('네 번째');
  store.setText(4, '네 번째');
  store.remove(1);
  store.resetToDefault();
  assert.deepEqual(countList, [4, 3, 3]);
});
