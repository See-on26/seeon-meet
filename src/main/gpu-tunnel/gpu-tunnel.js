const fs = require('fs');
const net = require('net');
const { TUNNEL_MODE_MAP } = require('./tunnel-config');
const { computeHostKeyFingerprint, isHostKeyFingerprintMatch } = require('./host-key');
const {
  TUNNEL_STATUS_MAP, TUNNEL_REASON_MAP, computeReconnectDelayMs, classifyTunnelError, describeTunnelStatus,
} = require('./tunnel-status');

// 외부 터널 스크립트와 같은 keepalive(15초 × 4회)로 끊김을 알아챈다.
const KEEPALIVE_INTERVAL_MS = 15000;
const KEEPALIVE_COUNT_MAX = 4;
const READY_TIMEOUT_MS = 10000;

const LOCAL_HOST = '127.0.0.1';
// 서버는 앱 키에 127.0.0.1:<포트> 로만 전달을 허용한다(permitopen).
const REMOTE_HOST = '127.0.0.1';

function createSshClient() {
  const { Client } = require('ssh2');
  return new Client();
}

function formatForwardList(forwardList) {
  return forwardList
    .map(({ localPort, remotePort }) => (localPort === remotePort ? `${localPort}` : `${localPort}→${remotePort}`))
    .join('·');
}

// 로컬 127.0.0.1:<포트> 를 직접 열고, 들어온 연결을 SSH direct-tcpip 로 GPU 서버의 같은 포트에 잇는다.
// SSH 가 끊겨 있는 동안 들어온 연결은 바로 닫아, 호출 쪽이 기다리지 않고 기존 폴백으로 넘어가게 한다.
function createGpuTunnel({
  tunnelConfig, forwardList,
  readPrivateKey = (keyPath) => fs.readFileSync(keyPath),
  createClient = createSshClient,
  createServer = net.createServer,
  setTimer = setTimeout, clearTimer = clearTimeout,
  log = (line) => console.log(line),
}) {
  const target = `${tunnelConfig.username}@${tunnelConfig.host}:${tunnelConfig.port}`;
  const listenerList = [];
  const serverList = [];
  const socketSet = new Set();
  let snapshot = { status: TUNNEL_STATUS_MAP.connecting, reason: null, retryInMs: null };
  let openedForwardList = [];
  let currentClient = null;
  let activeClient = null;
  let reconnectTimer = null;
  let failureCount = 0;
  let isStarted = false;
  let isStopped = false;

  function setStatus({ status, reason = null, retryInMs = null, detail = '' }) {
    snapshot = { status, reason, retryInMs };
    log(`[gpu-tunnel] ${describeTunnelStatus(snapshot)}${detail ? ` — ${detail}` : ''}`);
    for (const listener of listenerList) {
      try {
        listener({ ...snapshot });
      } catch (error) {
        log(`[gpu-tunnel] 상태 알림 실패(무시): ${error.message}`);
      }
    }
  }

  function handleLocalSocket({ socket, remotePort }) {
    socket.on('error', () => {});
    const client = activeClient;
    if (!client) {
      socket.destroy();
      return;
    }
    socketSet.add(socket);
    socket.once('close', () => socketSet.delete(socket));
    const handleChannel = (error, stream) => {
      if (error || socket.destroyed) {
        if (stream) stream.destroy();
        socket.destroy();
        return;
      }
      stream.on('error', () => socket.destroy());
      socket.once('close', () => stream.destroy());
      socket.pipe(stream).pipe(socket);
    };
    try {
      client.forwardOut(socket.remoteAddress || LOCAL_HOST, socket.remotePort || 0, REMOTE_HOST, remotePort, handleChannel);
    } catch {
      socket.destroy();
    }
  }

  function listenLocalPort({ localPort, remotePort }) {
    return new Promise((resolve) => {
      const server = createServer((socket) => handleLocalSocket({ socket, remotePort }));
      const handleListenError = (error) => {
        if (error.code !== 'EADDRINUSE') log(`[gpu-tunnel] 로컬 ${localPort} 포트를 열지 못했습니다: ${error.message}`);
        resolve(null);
      };
      server.once('error', handleListenError);
      server.listen(localPort, LOCAL_HOST, () => {
        server.off('error', handleListenError);
        server.on('error', (error) => log(`[gpu-tunnel] 로컬 ${localPort} 포트 오류: ${error.message}`));
        resolve(server);
      });
    });
  }

  function scheduleReconnect({ reason, detail = '' }) {
    const retryInMs = computeReconnectDelayMs(failureCount);
    failureCount += 1;
    setStatus({
      status: TUNNEL_STATUS_MAP.reconnecting, reason, retryInMs,
      detail: `${retryInMs}ms 뒤 다시 시도${detail ? ` · ${detail}` : ''}`,
    });
    reconnectTimer = setTimer(connect, retryInMs);
  }

  function connect() {
    reconnectTimer = null;
    if (isStopped) return;
    let privateKey;
    try {
      privateKey = readPrivateKey(tunnelConfig.keyPath);
    } catch (error) {
      // 오류 메시지에 키 경로가 들어 있어 코드만 남긴다.
      scheduleReconnect({ reason: TUNNEL_REASON_MAP.keyInvalid, detail: `키 파일을 읽지 못했습니다(${error.code || 'unknown'})` });
      return;
    }

    const client = createClient();
    currentClient = client;
    let isHostKeyMismatch = false;
    let mismatchFingerprint = '';
    let isDown = false;

    const handleDown = (error) => {
      if (isDown) return;
      isDown = true;
      if (activeClient === client) activeClient = null;
      if (currentClient === client) currentClient = null;
      try {
        client.end();
      } catch {}
      if (isStopped) return;
      const reason = classifyTunnelError({ error, isHostKeyMismatch });
      const detail = isHostKeyMismatch
        ? `서버 지문 ${mismatchFingerprint} 이 설정한 지문과 다릅니다`
        : (error ? error.message : '');
      scheduleReconnect({ reason, detail });
    };

    client.on('ready', () => {
      if (isDown || isStopped) return;
      activeClient = client;
      failureCount = 0;
      setStatus({ status: TUNNEL_STATUS_MAP.connected, detail: `${target} → 로컬 ${formatForwardList(openedForwardList)}` });
    });
    client.on('error', (error) => handleDown(error));
    client.on('close', () => handleDown(null));

    try {
      client.connect({
        host: tunnelConfig.host,
        port: tunnelConfig.port,
        username: tunnelConfig.username,
        privateKey,
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        hostVerifier: (hostKey) => {
          const isMatch = isHostKeyFingerprintMatch({ hostKey, expectedFingerprint: tunnelConfig.hostFingerprint });
          if (!isMatch) {
            isHostKeyMismatch = true;
            mismatchFingerprint = computeHostKeyFingerprint(hostKey);
          }
          return isMatch;
        },
      });
    } catch (error) {
      isDown = true;
      if (currentClient === client) currentClient = null;
      scheduleReconnect({ reason: TUNNEL_REASON_MAP.keyInvalid, detail: error.message });
    }
  }

  async function start() {
    if (isStarted) return;
    isStarted = true;
    if (tunnelConfig.mode === TUNNEL_MODE_MAP.off) {
      setStatus({ status: TUNNEL_STATUS_MAP.off, detail: 'SEEON_GPU_TUNNEL=off' });
      return;
    }
    if (!tunnelConfig.keyPath) {
      setStatus({
        status: TUNNEL_STATUS_MAP.noKey,
        detail: '앱 전용 키(SEEON_GPU_SSH_KEY)가 없어 터널을 열지 않습니다. 외부 터널을 켜 두면 그대로 동작합니다',
      });
      return;
    }

    const serverByForwardList = await Promise.all(forwardList.map(async (forward) => ({
      forward, server: await listenLocalPort(forward),
    })));
    const openedList = serverByForwardList.filter(({ server }) => server);
    serverList.push(...openedList.map(({ server }) => server));
    if (isStopped) {
      await closeServerList();
      return;
    }
    openedForwardList = openedList.map(({ forward }) => forward);
    const skippedForwardList = serverByForwardList.filter(({ server }) => !server).map(({ forward }) => forward);

    if (openedForwardList.length === 0) {
      setStatus({
        status: TUNNEL_STATUS_MAP.external,
        detail: forwardList.length
          ? `로컬 ${formatForwardList(skippedForwardList)} 포트를 이미 다른 터널이 쓰고 있어 연결하지 않습니다`
          : '로컬 포트로 부르는 GPU 서비스가 없습니다',
      });
      return;
    }
    if (skippedForwardList.length) {
      log(`[gpu-tunnel] 로컬 ${formatForwardList(skippedForwardList)} 포트는 이미 쓰이고 있어 건너뜁니다(외부 터널)`);
    }
    setStatus({ status: TUNNEL_STATUS_MAP.connecting, detail: `${target} → 로컬 ${formatForwardList(openedForwardList)}` });
    connect();
  }

  async function closeServerList() {
    const closingList = serverList.splice(0);
    await Promise.all(closingList.map((server) => new Promise((resolve) => server.close(() => resolve()))));
  }

  async function stop() {
    if (isStopped) return;
    isStopped = true;
    const hasOpened = serverList.length > 0 || Boolean(currentClient);
    if (reconnectTimer) clearTimer(reconnectTimer);
    reconnectTimer = null;
    const client = currentClient;
    currentClient = null;
    activeClient = null;
    if (client) {
      try {
        client.end();
      } catch {}
    }
    for (const socket of socketSet) socket.destroy();
    await closeServerList();
    if (hasOpened) log('[gpu-tunnel] 터널을 닫았습니다');
  }

  return {
    start,
    stop,
    getStatus: () => ({ ...snapshot }),
    onStatusChange(listener) {
      listenerList.push(listener);
      return () => {
        const index = listenerList.indexOf(listener);
        if (index !== -1) listenerList.splice(index, 1);
      };
    },
  };
}

module.exports = { createGpuTunnel };
