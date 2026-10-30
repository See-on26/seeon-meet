import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { UI_TEXT_MAP } from '../src/renderer/core/i18n/ui-text.js';
import { describeShareItem } from '../src/renderer/share-picker/share-item.js';

const require = createRequire(import.meta.url);
const {
  buildShareSourceList, createSharePicker, SHARE_PICKER_CHANNEL_MAP,
} = require('../src/main/meeting/share-picker.js');

function createSource({ id, name }) {
  return { id, name, thumbnail: { toDataURL: () => `data:image/png;base64,${id}` } };
}

const sourceList = [
  createSource({ id: 'window:11:0', name: 'PowerPoint - 발표.pptx' }),
  createSource({ id: 'screen:0:0', name: 'Screen 1' }),
  createSource({ id: 'window:22:0', name: 'seeon' }),
  createSource({ id: 'window:33:0', name: '' }),
  createSource({ id: 'screen:1:0', name: 'Screen 2' }),
];

test('공유 목록은 화면을 먼저, 창을 그 뒤에 두고 SEEON 창과 이름 없는 창은 뺀다', () => {
  assert.deepEqual(buildShareSourceList({ sourceList, ownSourceIdList: ['window:22:0'] }), [
    { id: 'screen:0:0', kind: 'screen', name: 'Screen 1', thumbnailDataUrl: 'data:image/png;base64,screen:0:0' },
    { id: 'screen:1:0', kind: 'screen', name: 'Screen 2', thumbnailDataUrl: 'data:image/png;base64,screen:1:0' },
    { id: 'window:11:0', kind: 'window', name: 'PowerPoint - 발표.pptx', thumbnailDataUrl: 'data:image/png;base64,window:11:0' },
  ]);
});

function createPickerFixture({ sources = sourceList, getSources = null } = {}) {
  const handlerMap = new Map();
  const windowList = [];
  let sourceOption = null;
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.listenerMap = {};
      this.webContents = { id: 100 + windowList.length };
      this.isClosed = false;
      this.isFocused = false;
      windowList.push(this);
    }

    loadFile(filePath) { this.filePath = filePath; }

    on(event, listener) { this.listenerMap[event] = listener; }

    once(event, listener) { this.listenerMap[event] = listener; }

    removeMenu() {}

    show() {}

    focus() { this.isFocused = true; }

    isDestroyed() { return this.isClosed; }

    close() {
      if (this.isClosed) return;
      this.isClosed = true;
      this.listenerMap.closed?.();
    }
  }
  const picker = createSharePicker({
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle: (channel, handler) => handlerMap.set(channel, handler) },
    desktopCapturer: {
      getSources: getSources || (async (option) => { sourceOption = option; return sources; }),
    },
    getParentWindow: () => ({ name: 'main' }),
    getOwnSourceIdList: () => ['window:22:0'],
    rootDir: '/app/src',
  });
  const callList = (channel, sender, payload) => handlerMap.get(channel)({ sender }, payload);
  return { picker, windowList, callList, readSourceOption: () => sourceOption };
}

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

test('발표를 누르면 화면과 창을 미리보기와 함께 모아 SEEON 선택 창을 띄우고, 고른 것을 넘긴다', async () => {
  const { picker, windowList, callList, readSourceOption } = createPickerFixture();
  const pending = picker.pick();
  await flush();
  assert.deepEqual(readSourceOption().types, ['screen', 'window']);
  assert.ok(readSourceOption().thumbnailSize.width >= 320);
  assert.equal(windowList.length, 1);
  assert.equal(windowList[0].options.modal, true);
  assert.deepEqual(windowList[0].options.parent, { name: 'main' });
  assert.match(windowList[0].filePath, /renderer\/share-picker\/picker\.html$/);

  const { webContents } = windowList[0];
  const itemList = await callList(SHARE_PICKER_CHANNEL_MAP.list, webContents);
  assert.deepEqual(itemList.map((item) => item.id), ['screen:0:0', 'screen:1:0', 'window:11:0']);

  await callList(SHARE_PICKER_CHANNEL_MAP.choose, webContents, { id: 'window:11:0' });
  assert.equal(await pending, sourceList[0], '목록에서 고른 원래 소스 객체를 넘긴다');
  assert.equal(windowList[0].isClosed, true);
});

test('취소하거나 선택 창을 닫으면 공유하지 않는다', async () => {
  const cancelFixture = createPickerFixture();
  const cancelPending = cancelFixture.picker.pick();
  await flush();
  await cancelFixture.callList(SHARE_PICKER_CHANNEL_MAP.choose, cancelFixture.windowList[0].webContents, { id: null });
  assert.equal(await cancelPending, null);

  const closeFixture = createPickerFixture();
  const closePending = closeFixture.picker.pick();
  await flush();
  closeFixture.windowList[0].close();
  assert.equal(await closePending, null);
});

test('선택 창이 떠 있는 동안 다시 공유를 요청하면 새 창을 띄우지 않고 떠 있는 창을 앞으로 가져온다', async () => {
  const { picker, windowList, callList } = createPickerFixture();
  const firstPending = picker.pick();
  await flush();
  assert.equal(await picker.pick(), null);
  assert.equal(windowList.length, 1);
  assert.equal(windowList[0].isFocused, true);

  await callList(SHARE_PICKER_CHANNEL_MAP.choose, windowList[0].webContents, { id: 'screen:1:0' });
  assert.equal(await firstPending, sourceList[4]);
});

test('목록에 없는 값이나 다른 창에서 온 선택은 받지 않는다', async () => {
  const { picker, windowList, callList } = createPickerFixture();
  const pending = picker.pick();
  await flush();
  await callList(SHARE_PICKER_CHANNEL_MAP.choose, { id: 999 }, { id: 'screen:0:0' });
  assert.equal(windowList[0].isClosed, false);
  await callList(SHARE_PICKER_CHANNEL_MAP.choose, windowList[0].webContents, { id: 'window:22:0' });
  assert.equal(await pending, null, 'SEEON 자기 창처럼 목록에서 뺀 것은 고를 수 없다');
});

test('고를 화면·창이 없거나 목록을 못 받으면 창을 띄우지 않고 공유하지 않는다', async () => {
  const emptyFixture = createPickerFixture({ sources: [] });
  assert.equal(await emptyFixture.picker.pick(), null);
  assert.equal(emptyFixture.windowList.length, 0);

  const failFixture = createPickerFixture({ getSources: async () => { throw new Error('denied'); } });
  assert.equal(await failFixture.picker.pick(), null);
  assert.equal(failFixture.windowList.length, 0);
});

test('선택 창 글자는 한국어·영어가 모두 있고, 항목 이름은 화면·창을 앞에 붙여 읽힌다', () => {
  const keyList = ['sharePicker.title', 'sharePicker.heading', 'sharePicker.screenHeading', 'sharePicker.windowHeading',
    'sharePicker.cancel', 'sharePicker.screenItem', 'sharePicker.windowItem'];
  for (const language of ['ko', 'en']) {
    for (const key of keyList) assert.ok(UI_TEXT_MAP[language][key], `${language} ${key}`);
  }
  const t = (key, params) => UI_TEXT_MAP.ko[key].replace('{name}', params.name);
  assert.equal(describeShareItem({ item: { kind: 'screen', name: 'Screen 1' }, t }), '화면: Screen 1');
  assert.equal(describeShareItem({ item: { kind: 'window', name: 'PowerPoint' }, t }), '창: PowerPoint');
});

test('Meet 공유 요청은 첫 화면을 바로 넘기지 않고 SEEON 선택 창에서 고른 것을 넘긴다', () => {
  const sessionSource = fs.readFileSync(new URL('../src/main/meeting/session.js', import.meta.url), 'utf8');
  assert.doesNotMatch(sessionSource, /sourceList\[0\]/);
  assert.match(sessionSource, /pickShareSource\(\)/);
  const windowSource = fs.readFileSync(new URL('../src/main/window.js', import.meta.url), 'utf8');
  assert.match(windowSource, /createMeetSession\(\{ getViewerView, pickShareSource: sharePicker\.pick \}\)/);
});
