const { createDevFlowRecorder } = require('./dev-flow-recorder');
const { createDevFlowWindowManager } = require('./dev-flow-window');
const { buildDevFlowSnapshot } = require('./dev-flow-snapshot');

// 개발자 모드: 제품 화면의 로고를 연달아 누르면 렌더러가 이 채널로 흐름 창을 연다.
const DEV_FLOW_OPEN_CHANNEL = 'dev-flow-open';

// 기록기는 늘 모으고, 기록이 바뀌면 열려 있는 흐름 창에만 갱신을 보낸다.
function createDevFlow({ ipcMain, BrowserWindow, now = Date.now }) {
  let windowManager = null;
  const recorder = createDevFlowRecorder({ now, onChange: () => windowManager?.schedulePush() });
  windowManager = createDevFlowWindowManager({
    BrowserWindow, buildSnapshot: () => buildDevFlowSnapshot({ session: recorder.getSession(), nowWallMs: now() }),
  });
  ipcMain.handle(DEV_FLOW_OPEN_CHANNEL, () => {
    windowManager.open();
    return { isOk: true };
  });
  return { recorder, windowManager };
}

module.exports = { createDevFlow, DEV_FLOW_OPEN_CHANNEL };
