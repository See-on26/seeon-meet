import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reloadMeetView, registerMeetReload } = require('../src/main/meeting/meet-reload.js');
const { buildAppMenuTemplate, MEET_RELOAD_ACCELERATOR } = require('../src/main/app-menu.js');

const MEETING_URL = 'https://meet.google.com/abc-defg-hij';

function makeView({ isDestroyed = false, url = MEETING_URL } = {}) {
  const callList = [];
  return {
    callList,
    webContents: {
      isDestroyed: () => isDestroyed,
      getURL: () => url,
      reload: () => callList.push(['reload']),
      loadURL: (target) => callList.push(['loadURL', target]),
      send: (channel, payload) => callList.push(['send', channel, payload]),
    },
  };
}

function flattenItemList(template) {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flattenItemList(item.submenu) : [])]);
}

test('회의 주소에 있으면 그 회의 화면만 새로고침하고 뷰어에 알린다', () => {
  const meetView = makeView();
  const viewerView = makeView();
  const isReloaded = reloadMeetView({ getMeetView: () => meetView, getViewerView: () => viewerView, reason: 'shortcut' });
  assert.equal(isReloaded, true);
  assert.deepEqual(meetView.callList, [['reload']]);
  assert.deepEqual(viewerView.callList, [['send', 'meet-reloaded', { reason: 'shortcut', target: 'meeting' }]]);
});

test('회의 밖 페이지에 있으면 Meet 첫 화면으로 돌아가고 뷰어에 알린다', () => {
  for (const url of ['https://workspace.google.com/products/meet/', 'https://meet.google.com/', 'about:blank']) {
    const meetView = makeView({ url });
    const viewerView = makeView();
    assert.equal(reloadMeetView({ getMeetView: () => meetView, getViewerView: () => viewerView, reason: 'button' }), true);
    assert.deepEqual(meetView.callList, [['loadURL', 'https://meet.google.com/']], url);
    assert.deepEqual(viewerView.callList, [['send', 'meet-reloaded', { reason: 'button', target: 'home' }]], url);
  }
});

test('Meet 화면이 없거나 파괴됐으면 아무것도 하지 않는다', () => {
  const viewerView = makeView();
  assert.equal(reloadMeetView({ getMeetView: () => null, getViewerView: () => viewerView, reason: 'button' }), false);
  assert.equal(reloadMeetView({ getMeetView: () => makeView({ isDestroyed: true }), getViewerView: () => viewerView, reason: 'button' }), false);
  assert.equal(viewerView.callList.length, 0);
});

test('뷰어가 파괴돼도 Meet 새로고침은 한다', () => {
  const meetView = makeView();
  assert.equal(reloadMeetView({ getMeetView: () => meetView, getViewerView: () => makeView({ isDestroyed: true }), reason: 'shortcut' }), true);
  assert.deepEqual(meetView.callList, [['reload']]);
});

test('뷰어 버튼용 IPC 를 등록한다', async () => {
  const handlerMap = new Map();
  const meetView = makeView();
  registerMeetReload({
    ipcMain: { handle: (channel, fn) => handlerMap.set(channel, fn) },
    getMeetView: () => meetView, getViewerView: () => makeView(),
  });
  assert.deepEqual(await handlerMap.get('meet-reload')({}), { isOk: true });
  assert.deepEqual(meetView.callList, [['reload']]);
});

test('앱 메뉴: Cmd/Ctrl+R 은 Meet 새로고침에 연결된다', () => {
  let reloadCount = 0;
  const itemList = flattenItemList(buildAppMenuTemplate({ onReloadMeet: () => { reloadCount += 1; }, platform: 'darwin' }));
  const reloadItem = itemList.find((item) => item.accelerator === MEET_RELOAD_ACCELERATOR);
  assert.equal(MEET_RELOAD_ACCELERATOR, 'CmdOrCtrl+R');
  reloadItem.click();
  assert.equal(reloadCount, 1);
});

test('앱 메뉴: 기본 새로고침 역할은 빼고 편집(복사·붙여넣기) 메뉴는 남긴다', () => {
  const itemList = flattenItemList(buildAppMenuTemplate({ onReloadMeet: () => {}, platform: 'darwin' }));
  const roleList = itemList.map((item) => item.role).filter(Boolean);
  assert.ok(!roleList.includes('reload'));
  assert.ok(!roleList.includes('forceReload'));
  assert.ok(roleList.includes('editMenu'));
  assert.equal(itemList[0].role, 'appMenu');
});

test('앱 메뉴: macOS 가 아니면 앱 메뉴 역할을 넣지 않는다', () => {
  const template = buildAppMenuTemplate({ onReloadMeet: () => {}, platform: 'win32' });
  assert.ok(!template.some((item) => item.role === 'appMenu'));
});
