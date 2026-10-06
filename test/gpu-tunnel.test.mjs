import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { Duplex } from 'node:stream';

const require = createRequire(import.meta.url);
const { createGpuTunnel } = require('../src/main/gpu-tunnel/gpu-tunnel.js');
const { registerGpuTunnel } = require('../src/main/gpu-tunnel/index.js');
const { TUNNEL_STATUS_MAP, TUNNEL_REASON_MAP } = require('../src/main/gpu-tunnel/tunnel-status.js');
const { DEFAULT_HOST_FINGERPRINT } = require('../src/main/gpu-tunnel/tunnel-config.js');

const FAKE_PRIVATE_KEY = Buffer.from('fake-private-key');

function createFakeClient() {
  const client = new EventEmitter();
  client.connectOptions = null;
  client.forwardCallList = [];
  client.isEnded = false;
  client.connect = (options) => { client.connectOptions = options; };
  client.forwardOut = (srcIP, srcPort, dstIP, dstPort, callback) => {
    client.forwardCallList.push({ srcIP, srcPort, dstIP, dstPort });
    callback(null, createEchoStream());
  };
  client.end = () => {
    if (client.isEnded) return;
    client.isEnded = true;
    setImmediate(() => client.emit('close'));
  };
  return client;
}

// 원격 서비스 대신 받은 바이트를 그대로 돌려준다.
function createEchoStream() {
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) { stream.push(chunk); callback(); },
    final(callback) { stream.push(null); callback(); },
  });
  return stream;
}

function createFakeTimer() {
  const pendingList = [];
  return {
    pendingList,
    setTimer: (fn, delayMs) => { const entry = { fn, delayMs, isCleared: false }; pendingList.push(entry); return entry; },
    clearTimer: (entry) => { if (entry) entry.isCleared = true; },
    runNext() {
      const entry = pendingList.shift();
      if (!entry.isCleared) entry.fn();
      return entry.delayMs;
    },
  };
}

async function findFreePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function occupyPort() {
  const server = net.createServer((socket) => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function connectLocal(port) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  return socket;
}

async function readUntilClose(socket) {
  const chunkList = [];
  socket.on('data', (chunk) => chunkList.push(chunk));
  await once(socket, 'close');
  return Buffer.concat(chunkList).toString();
}

const BASE_TUNNEL_CONFIG = {
  mode: 'auto', host: 'gpu.example.com', port: 2222, username: 'tester',
  keyPath: '/keys/app-key', hostFingerprint: DEFAULT_HOST_FINGERPRINT,
};

const cleanupList = [];
afterEach(async () => {
  while (cleanupList.length) await cleanupList.pop()();
});

function makeTunnel({ tunnelConfig = BASE_TUNNEL_CONFIG, forwardList, timer = createFakeTimer() }) {
  const clientList = [];
  const statusList = [];
  const logList = [];
  const tunnel = createGpuTunnel({
    tunnelConfig, forwardList,
    readPrivateKey: () => FAKE_PRIVATE_KEY,
    createClient: () => { const client = createFakeClient(); clientList.push(client); return client; },
    setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    log: (line) => logList.push(line),
  });
  tunnel.onStatusChange((snapshot) => statusList.push(snapshot));
  cleanupList.push(() => tunnel.stop());
  return { tunnel, clientList, statusList, logList, timer };
}

test('SEEON_GPU_TUNNEL=off 면 포트도 SSH 도 열지 않는다', async () => {
  const localPort = await findFreePort();
  const { tunnel, clientList } = makeTunnel({
    tunnelConfig: { ...BASE_TUNNEL_CONFIG, mode: 'off' }, forwardList: [{ localPort, remotePort: 8802 }],
  });
  await tunnel.start();
  assert.equal(tunnel.getStatus().status, TUNNEL_STATUS_MAP.off);
  assert.equal(clientList.length, 0);
  const probeServer = net.createServer().listen(localPort, '127.0.0.1');
  await once(probeServer, 'listening');
  await new Promise((resolve) => probeServer.close(resolve));
});

test('키가 없으면 no_key 로 두고 SSH 를 열지 않는다', async () => {
  const localPort = await findFreePort();
  const { tunnel, clientList } = makeTunnel({
    tunnelConfig: { ...BASE_TUNNEL_CONFIG, keyPath: null }, forwardList: [{ localPort, remotePort: 8802 }],
  });
  await tunnel.start();
  assert.equal(tunnel.getStatus().status, TUNNEL_STATUS_MAP.noKey);
  assert.equal(clientList.length, 0);
});

test('연결: 설정한 주소·키·keepalive 15초×4·readyTimeout 10초로 붙고, 지문이 다르면 거부한다', async () => {
  const localPort = await findFreePort();
  const { tunnel, clientList, statusList } = makeTunnel({ forwardList: [{ localPort, remotePort: 8802 }] });
  await tunnel.start();
  assert.equal(clientList.length, 1);
  const options = clientList[0].connectOptions;
  assert.equal(options.host, 'gpu.example.com');
  assert.equal(options.port, 2222);
  assert.equal(options.username, 'tester');
  assert.equal(options.privateKey, FAKE_PRIVATE_KEY);
  assert.equal(options.keepaliveInterval, 15000);
  assert.equal(options.keepaliveCountMax, 4);
  assert.equal(options.readyTimeout, 10000);
  assert.equal(options.hostVerifier(Buffer.from('not-the-server-key')), false);
  assert.equal(statusList[0].status, TUNNEL_STATUS_MAP.connecting);
});

test('SSH 가 붙기 전 들어온 로컬 연결은 바로 닫는다', async () => {
  const localPort = await findFreePort();
  const { tunnel, clientList } = makeTunnel({ forwardList: [{ localPort, remotePort: 8802 }] });
  await tunnel.start();
  const socket = connectLocal(localPort);
  assert.equal(await readUntilClose(socket), '');
  assert.equal(clientList[0].forwardCallList.length, 0);
});

test('SSH 가 붙은 뒤 로컬 연결은 forwardOut 으로 원격 127.0.0.1:<포트> 에 잇는다', async () => {
  const localPort = await findFreePort();
  const { tunnel, clientList } = makeTunnel({ forwardList: [{ localPort, remotePort: 8802 }] });
  await tunnel.start();
  clientList[0].emit('ready');
  assert.equal(tunnel.getStatus().status, TUNNEL_STATUS_MAP.connected);

  const socket = connectLocal(localPort);
  await once(socket, 'connect');
  socket.end('ping');
  assert.equal(await readUntilClose(socket), 'ping');
  assert.equal(clientList[0].forwardCallList.length, 1);
  assert.equal(clientList[0].forwardCallList[0].dstIP, '127.0.0.1');
  assert.equal(clientList[0].forwardCallList[0].dstPort, 8802);
});

test('forwardOut 이 실패하면 로컬 연결을 닫는다', async () => {
  const localPort = await findFreePort();
  const { tunnel, clientList } = makeTunnel({ forwardList: [{ localPort, remotePort: 8802 }] });
  await tunnel.start();
  clientList[0].forwardOut = (_srcIP, _srcPort, _dstIP, _dstPort, callback) => callback(new Error('open failed'));
  clientList[0].emit('ready');
  const socket = connectLocal(localPort);
  assert.equal(await readUntilClose(socket), '');
});

test('이미 쓰이는 포트는 건너뛰고 나머지만 연다', async () => {
  const blocker = await occupyPort();
  cleanupList.push(() => new Promise((resolve) => blocker.close(resolve)));
  const busyPort = blocker.address().port;
  const freePort = await findFreePort();
  const { tunnel, clientList } = makeTunnel({
    forwardList: [{ localPort: busyPort, remotePort: 8801 }, { localPort: freePort, remotePort: 8802 }],
  });
  await tunnel.start();
  assert.equal(tunnel.getStatus().status, TUNNEL_STATUS_MAP.connecting);
  assert.equal(clientList.length, 1);
  clientList[0].emit('ready');

  const socket = connectLocal(freePort);
  await once(socket, 'connect');
  socket.end('hi');
  assert.equal(await readUntilClose(socket), 'hi');
  assert.deepEqual(clientList[0].forwardCallList.map(({ dstPort }) => dstPort), [8802]);
});

test('모든 포트를 다른 터널이 쓰고 있으면 SSH 연결 없이 external', async () => {
  const blockerA = await occupyPort();
  const blockerB = await occupyPort();
  cleanupList.push(() => new Promise((resolve) => blockerA.close(resolve)));
  cleanupList.push(() => new Promise((resolve) => blockerB.close(resolve)));
  const { tunnel, clientList, logList } = makeTunnel({
    forwardList: [
      { localPort: blockerA.address().port, remotePort: 8801 },
      { localPort: blockerB.address().port, remotePort: 8802 },
    ],
  });
  await tunnel.start();
  assert.equal(tunnel.getStatus().status, TUNNEL_STATUS_MAP.external);
  assert.equal(clientList.length, 0);
  assert.ok(logList.some((line) => line.startsWith('[gpu-tunnel]')));
});

test('끊기면 reconnecting(2초 뒤) → 다시 붙으면 connected, 붙은 뒤에는 간격이 처음부터', async () => {
  const localPort = await findFreePort();
  const { tunnel, clientList, statusList, timer } = makeTunnel({ forwardList: [{ localPort, remotePort: 8802 }] });
  await tunnel.start();
  clientList[0].emit('ready');
  clientList[0].emit('close');

  assert.deepEqual(tunnel.getStatus(), {
    status: TUNNEL_STATUS_MAP.reconnecting, reason: TUNNEL_REASON_MAP.disconnected, retryInMs: 2000,
  });
  const beforeRetrySocket = connectLocal(localPort);
  assert.equal(await readUntilClose(beforeRetrySocket), '');

  assert.equal(timer.runNext(), 2000);
  assert.equal(clientList.length, 2);
  clientList[1].emit('ready');
  assert.equal(tunnel.getStatus().status, TUNNEL_STATUS_MAP.connected);
  assert.deepEqual(statusList.map(({ status }) => status), [
    TUNNEL_STATUS_MAP.connecting, TUNNEL_STATUS_MAP.connected,
    TUNNEL_STATUS_MAP.reconnecting, TUNNEL_STATUS_MAP.connected,
  ]);

  clientList[1].emit('close');
  assert.equal(tunnel.getStatus().retryInMs, 2000);
});

test('인증 실패·지문 불일치는 이유를 남기고 2·4·8초 … 간격으로 다시 시도한다', async () => {
  const localPort = await findFreePort();
  const { tunnel, clientList, timer } = makeTunnel({ forwardList: [{ localPort, remotePort: 8802 }] });
  await tunnel.start();

  clientList[0].emit('error', Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }));
  clientList[0].emit('close');
  assert.deepEqual(tunnel.getStatus(), {
    status: TUNNEL_STATUS_MAP.reconnecting, reason: TUNNEL_REASON_MAP.authFailed, retryInMs: 2000,
  });
  assert.equal(timer.pendingList.length, 1);

  timer.runNext();
  const secondClient = clientList[1];
  assert.equal(secondClient.connectOptions.hostVerifier(Buffer.from('other-server-key')), false);
  secondClient.emit('error', Object.assign(new Error('Host denied (verification failed)'), { level: 'handshake' }));
  secondClient.emit('close');
  assert.deepEqual(tunnel.getStatus(), {
    status: TUNNEL_STATUS_MAP.reconnecting, reason: TUNNEL_REASON_MAP.hostKeyMismatch, retryInMs: 4000,
  });

  timer.runNext();
  clientList[2].emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  assert.equal(tunnel.getStatus().retryInMs, 8000);
  assert.equal(tunnel.getStatus().reason, TUNNEL_REASON_MAP.network);
  clientList[2].emit('close');
  assert.equal(timer.pendingList.length, 1);
});

test('키 파싱 실패처럼 connect 가 바로 던져도 다시 시도한다', async () => {
  const localPort = await findFreePort();
  const timer = createFakeTimer();
  const clientList = [];
  const tunnel = createGpuTunnel({
    tunnelConfig: BASE_TUNNEL_CONFIG, forwardList: [{ localPort, remotePort: 8802 }],
    readPrivateKey: () => FAKE_PRIVATE_KEY,
    createClient: () => {
      const client = createFakeClient();
      client.connect = () => { throw new Error('Cannot parse privateKey: Unsupported key format'); };
      clientList.push(client);
      return client;
    },
    setTimer: timer.setTimer, clearTimer: timer.clearTimer, log: () => {},
  });
  cleanupList.push(() => tunnel.stop());
  await tunnel.start();
  assert.deepEqual(tunnel.getStatus(), {
    status: TUNNEL_STATUS_MAP.reconnecting, reason: TUNNEL_REASON_MAP.keyInvalid, retryInMs: 2000,
  });
});

test('로그에는 키 경로·키 내용이 나오지 않는다', async () => {
  const localPort = await findFreePort();
  const { tunnel, clientList, logList } = makeTunnel({ forwardList: [{ localPort, remotePort: 8802 }] });
  await tunnel.start();
  clientList[0].emit('ready');
  clientList[0].emit('close');
  assert.ok(logList.length >= 3);
  for (const line of logList) {
    assert.match(line, /^\[gpu-tunnel\] /);
    assert.doesNotMatch(line, /\/keys\/app-key|fake-private-key/);
  }
});

test('stop 하면 로컬 포트·SSH 를 닫고 다시 붙지 않는다', async () => {
  const localPort = await findFreePort();
  const { tunnel, clientList, timer } = makeTunnel({ forwardList: [{ localPort, remotePort: 8802 }] });
  await tunnel.start();
  clientList[0].emit('ready');
  await tunnel.stop();
  assert.equal(clientList[0].isEnded, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timer.pendingList.length, 0);
  const probeServer = net.createServer().listen(localPort, '127.0.0.1');
  await once(probeServer, 'listening');
  await new Promise((resolve) => probeServer.close(resolve));
});

test('registerGpuTunnel: 상태를 묻는 IPC, 바뀔 때 뷰어 알림, 종료 때 정리', async () => {
  const handlerMap = new Map();
  const appListenerMap = new Map();
  const sentList = [];
  let statusListener = null;
  let isStopped = false;
  const fakeTunnel = {
    start: async () => {},
    stop: async () => { isStopped = true; },
    getStatus: () => ({ status: TUNNEL_STATUS_MAP.external, reason: null, retryInMs: null }),
    onStatusChange: (listener) => { statusListener = listener; },
  };
  registerGpuTunnel({
    app: { isPackaged: false, on: (eventName, fn) => appListenerMap.set(eventName, fn) },
    ipcMain: { handle: (channel, fn) => handlerMap.set(channel, fn) },
    getViewerView: () => ({
      webContents: { isDestroyed: () => false, send: (channel, payload) => sentList.push([channel, payload]) },
    }),
    env: {},
    createTunnel: () => fakeTunnel,
  });

  assert.deepEqual(await handlerMap.get('gpu-tunnel-status')({}), {
    status: TUNNEL_STATUS_MAP.external, reason: null, retryInMs: null, label: '외부 터널',
  });
  statusListener({ status: TUNNEL_STATUS_MAP.reconnecting, reason: TUNNEL_REASON_MAP.timeout, retryInMs: 2000 });
  assert.deepEqual(sentList, [['gpu-tunnel-status-changed', {
    status: TUNNEL_STATUS_MAP.reconnecting, reason: TUNNEL_REASON_MAP.timeout, retryInMs: 2000,
    label: '다시 연결 중 (응답 없음)',
  }]]);
  appListenerMap.get('before-quit')();
  assert.equal(isStopped, true);
});

test('registerGpuTunnel: 뷰어가 아직 없거나 파괴됐으면 알리지 않는다', () => {
  let statusListener = null;
  registerGpuTunnel({
    app: { isPackaged: false, on: () => {} },
    ipcMain: { handle: () => {} },
    getViewerView: () => null,
    env: {},
    createTunnel: () => ({
      start: async () => {}, stop: async () => {},
      getStatus: () => ({ status: TUNNEL_STATUS_MAP.connecting, reason: null, retryInMs: null }),
      onStatusChange: (listener) => { statusListener = listener; },
    }),
  });
  assert.doesNotThrow(() => statusListener({ status: TUNNEL_STATUS_MAP.connected, reason: null, retryInMs: null }));
});
