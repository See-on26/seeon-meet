const path = require('path');

// Meet 에서 발표를 누르면 공유할 화면이나 창을 SEEON 선택 창에서 고른다. Windows 에는 Chrome 같은 시스템 선택 창이 없어
// 고르는 단계가 없으면 첫 모니터 전체만 공유된다(다른 앱 창·둘째 모니터를 고를 수 없다).
const SHARE_PICKER_CHANNEL_MAP = Object.freeze({ list: 'share-picker-list', choose: 'share-picker-choose' });
const SHARE_SOURCE_TYPE_LIST = ['screen', 'window'];
const THUMBNAIL_SIZE = { width: 320, height: 180 };
const PICKER_WINDOW_SIZE = { width: 760, height: 620 };

const readSourceKind = (id) => (String(id).startsWith('screen:') ? 'screen' : 'window');

// 화면을 먼저, 창은 받은 순서대로 둔다. SEEON 창 자신과 이름 없는 창(숨은 도구 창 등)은 뺀다.
function buildShareSourceList({ sourceList, ownSourceIdList }) {
  return sourceList
    .filter((source) => !ownSourceIdList.includes(source.id))
    .map((source) => ({
      id: source.id,
      kind: readSourceKind(source.id),
      name: String(source.name || '').trim(),
      thumbnailDataUrl: source.thumbnail?.toDataURL?.() || '',
    }))
    .filter((item) => item.kind === 'screen' || item.name)
    .sort((left, right) => SHARE_SOURCE_TYPE_LIST.indexOf(left.kind) - SHARE_SOURCE_TYPE_LIST.indexOf(right.kind));
}

function createSharePicker({
  BrowserWindow, ipcMain, desktopCapturer, getParentWindow, getOwnSourceIdList, rootDir = path.join(__dirname, '..', '..'),
}) {
  // 떠 있는 선택 창 하나: { window, itemList, sourceMap, resolve }. 목록을 모으는 중에도 새 요청은 받지 않는다.
  let active = null;
  let isCollecting = false;

  const isFromActive = (event) => Boolean(active) && event.sender === active.window.webContents;

  function finish(source) {
    if (!active) return;
    const { window, resolve } = active;
    active = null;
    resolve(source);
    if (!window.isDestroyed()) window.close();
  }

  ipcMain.handle(SHARE_PICKER_CHANNEL_MAP.list, (event) => (isFromActive(event) ? active.itemList : []));
  // 목록에 없는 값(취소의 null 포함)은 공유하지 않는다.
  ipcMain.handle(SHARE_PICKER_CHANNEL_MAP.choose, (event, { id } = {}) => {
    if (!isFromActive(event)) return { isOk: false };
    finish(active.sourceMap.get(id) || null);
    return { isOk: true };
  });

  function openPickerWindow({ itemList, sourceMap }) {
    return new Promise((resolve) => {
      const window = new BrowserWindow({
        ...PICKER_WINDOW_SIZE,
        parent: getParentWindow() || undefined,
        modal: true,
        show: false,
        title: 'seeon',
        autoHideMenuBar: true,
        minimizable: false,
        maximizable: false,
        webPreferences: { preload: path.join(rootDir, 'preload', 'share-picker.js'), contextIsolation: true },
      });
      active = { window, itemList, sourceMap, resolve };
      window.removeMenu();
      window.once('ready-to-show', () => window.show());
      window.on('closed', () => {
        if (active?.window !== window) return;
        active = null;
        resolve(null);
      });
      window.loadFile(path.join(rootDir, 'renderer', 'share-picker', 'picker.html'));
    });
  }

  // 고른 desktopCapturer 소스를 돌려준다. 취소·닫음·고를 것이 없음·이미 떠 있음이면 null(공유하지 않음).
  async function pick() {
    if (active) {
      active.window.focus();
      return null;
    }
    if (isCollecting) return null;
    isCollecting = true;
    let sourceList = [];
    try {
      sourceList = await desktopCapturer.getSources({ types: SHARE_SOURCE_TYPE_LIST, thumbnailSize: THUMBNAIL_SIZE });
    } catch (error) {
      console.warn(`[share] 공유할 화면·창 목록을 받지 못함: ${error.message}`);
      return null;
    } finally {
      isCollecting = false;
    }
    const itemList = buildShareSourceList({ sourceList, ownSourceIdList: getOwnSourceIdList() });
    if (!itemList.length) return null;
    const idSet = new Set(itemList.map((item) => item.id));
    const sourceMap = new Map(sourceList.filter((source) => idSet.has(source.id)).map((source) => [source.id, source]));
    return openPickerWindow({ itemList, sourceMap });
  }

  return { pick };
}

module.exports = { buildShareSourceList, createSharePicker, SHARE_PICKER_CHANNEL_MAP };
