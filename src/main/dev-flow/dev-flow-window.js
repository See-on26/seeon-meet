const path = require('path');

// 제품 개발자 모드 흐름 창. 기록이 들어올 때마다 흐름·신호등을 모아(≈300ms 에 한 번) 보낸다.
// 들어오는 것이 없어도 신호등이 3초 뒤 꺼지도록 열려 있는 동안 1초마다 다시 보낸다. 창이 닫혀 있으면 흐름을 만들지 않는다.
const DEV_FLOW_WINDOW_SIZE = { width: 1100, height: 900 };
const DEV_FLOW_PUSH_THROTTLE_MS = 300;
const DEV_FLOW_TICK_MS = 1000;
const DEV_FLOW_UPDATE_CHANNEL = 'dev-flow-update';

function createDevFlowWindowManager({
  BrowserWindow, buildSnapshot, rootDir = path.join(__dirname, '..', '..'),
  throttleMs = DEV_FLOW_PUSH_THROTTLE_MS, tickMs = DEV_FLOW_TICK_MS,
  setTimer = setTimeout, clearTimer = clearTimeout, setTick = setInterval, clearTick = clearInterval,
}) {
  let flowWindow = null;
  let pushTimer = null;
  let tickTimer = null;
  const isOpen = () => Boolean(flowWindow) && !flowWindow.isDestroyed() && !flowWindow.webContents.isDestroyed();

  // 갱신값을 만들다 실패해도 main 프로세스 예외가 되지 않게 알리기만 한다.
  function pushNow() {
    if (!isOpen()) return;
    try {
      flowWindow.webContents.send(DEV_FLOW_UPDATE_CHANNEL, buildSnapshot());
    } catch (error) {
      console.warn(`[dev-flow] 흐름 창 갱신 실패: ${error.message}`);
    }
  }

  function schedulePush() {
    if (!isOpen() || pushTimer) return;
    pushTimer = setTimer(() => {
      pushTimer = null;
      pushNow();
    }, throttleMs);
  }

  function stopTimers() {
    if (pushTimer) clearTimer(pushTimer);
    if (tickTimer) clearTick(tickTimer);
    pushTimer = null;
    tickTimer = null;
  }

  function open() {
    if (isOpen()) {
      flowWindow.focus();
      return flowWindow;
    }
    flowWindow = new BrowserWindow({
      ...DEV_FLOW_WINDOW_SIZE,
      title: 'seeon 개발자 모드 — 파이프라인 흐름',
      backgroundColor: '#111114',
      webPreferences: { preload: path.join(rootDir, 'preload', 'dev-flow.js'), contextIsolation: true },
    });
    flowWindow.webContents.on('did-finish-load', pushNow);
    flowWindow.loadFile(path.join(rootDir, 'renderer', 'dev-flow', 'flow.html'));
    tickTimer = setTick(pushNow, tickMs);
    flowWindow.on('closed', () => {
      stopTimers();
      flowWindow = null;
    });
    return flowWindow;
  }

  return { open, isOpen, schedulePush, pushNow };
}

module.exports = { createDevFlowWindowManager, DEV_FLOW_UPDATE_CHANNEL, DEV_FLOW_PUSH_THROTTLE_MS };
