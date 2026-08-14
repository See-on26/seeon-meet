import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMeetMicToggleInputList, registerMeetMicControl } = require('../src/main/meeting/meet-mic-control.js');

test('맥은 Cmd+D, 그 외는 Ctrl+D', () => {
  assert.deepEqual(buildMeetMicToggleInputList({ platform: 'darwin' }), [
    { type: 'keyDown', keyCode: 'D', modifiers: ['meta'] },
    { type: 'keyUp', keyCode: 'D', modifiers: ['meta'] },
  ]);
  assert.deepEqual(buildMeetMicToggleInputList({ platform: 'win32' })[0].modifiers, ['control']);
});

test('IPC 는 Meet 화면에 입력 이벤트를 보내고, 화면이 없으면 실패를 돌려준다', async () => {
  const handlerMap = new Map();
  const sentList = [];
  let meetView = { webContents: { isDestroyed: () => false, sendInputEvent: (event) => sentList.push(event) } };
  registerMeetMicControl({ ipcMain: { handle: (channel, fn) => handlerMap.set(channel, fn) }, getMeetView: () => meetView, platform: 'darwin' });
  assert.deepEqual(await handlerMap.get('meet-mic-toggle')(), { isOk: true });
  assert.equal(sentList.length, 2);
  meetView = null;
  assert.deepEqual(await handlerMap.get('meet-mic-toggle')(), { isOk: false });
});
