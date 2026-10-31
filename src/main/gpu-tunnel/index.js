const { readPipelineConfig } = require('../caption-pipeline/config');
const { readTunnelConfig, buildForwardList } = require('./tunnel-config');
const { createGpuTunnel } = require('./gpu-tunnel');
const { describeTunnelStatus } = require('./tunnel-status');

function toViewerPayload(snapshot) {
  return { ...snapshot, label: describeTunnelStatus(snapshot) };
}

// 앱이 켜질 때 GPU 서버 터널을 열고, 설정 패널이 상태를 볼 수 있게 한다.
function registerGpuTunnel({ app, ipcMain, getViewerView, env = process.env, createTunnel = createGpuTunnel }) {
  const tunnelConfig = readTunnelConfig({ env, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const forwardList = buildForwardList({ pipelineConfig: readPipelineConfig(env) });
  const tunnel = createTunnel({ tunnelConfig, forwardList });

  tunnel.onStatusChange((snapshot) => {
    const viewerView = getViewerView();
    if (!viewerView || viewerView.webContents.isDestroyed()) return;
    viewerView.webContents.send('gpu-tunnel-status-changed', toViewerPayload(snapshot));
  });
  ipcMain.handle('gpu-tunnel-status', async () => toViewerPayload(tunnel.getStatus()));
  app.on('before-quit', () => { tunnel.stop(); });

  tunnel.start().catch((error) => console.error(`[gpu-tunnel] 시작 실패: ${error.message}`));
  return tunnel;
}

module.exports = { registerGpuTunnel };
