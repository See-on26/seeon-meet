const fs = require('fs');
const os = require('os');
const path = require('path');

const TUNNEL_MODE_MAP = { auto: 'auto', off: 'off' };

// GPU 서버 주소·계정·호스트 키 지문은 저장소에 두지 않고 .env(SEEON_GPU_SSH_HOST·SEEON_GPU_SSH_USER·
// SEEON_GPU_SSH_HOST_FINGERPRINT)로만 받는다. 하나라도 없으면 터널을 열지 않는다. 포트를 주지 않으면 SSH 기본 포트다.
const DEFAULT_SSH_PORT = 22;

// 설치본은 앱 전용 키를 resources 폴더에 이 이름으로 넣는다.
const PACKAGED_KEY_FILE_NAME = 'gpu-tunnel-key';

const LOCAL_HOSTNAME_LIST = ['127.0.0.1', 'localhost'];
const FORWARD_URL_KEY_LIST = ['vlmUrl', 'asrUrl', 'ttsUrl', 'ttsLongUrl', 'embedUrl', 'ocrUrl', 'judgeGpuUrl'];

function readTunnelMode(env) {
  const mode = env.SEEON_GPU_TUNNEL;
  if (mode === undefined || mode === '') return TUNNEL_MODE_MAP.auto;
  if (Object.values(TUNNEL_MODE_MAP).includes(mode)) return mode;
  console.warn(`[gpu-tunnel] SEEON_GPU_TUNNEL="${mode}" 은 지원하지 않는 값입니다 — auto 로 둡니다 (허용: auto·off)`);
  return TUNNEL_MODE_MAP.auto;
}

function readSshPort(env) {
  const rawPort = env.SEEON_GPU_SSH_PORT;
  if (rawPort === undefined || rawPort === '') return DEFAULT_SSH_PORT;
  const port = Number(rawPort);
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  console.warn(`[gpu-tunnel] SEEON_GPU_SSH_PORT="${rawPort}" 은 포트 번호가 아닙니다 — ${DEFAULT_SSH_PORT} 로 붙습니다`);
  return DEFAULT_SSH_PORT;
}

function expandHomeDir({ filePath, homeDir }) {
  return filePath.startsWith('~/') ? path.join(homeDir, filePath.slice(2)) : filePath;
}

// 환경변수 키 → (설치본이면) resources 키 순서로, 실제로 있는 첫 파일을 쓴다. 로그에 경로는 남기지 않는다.
function resolveKeyPath({ env, isPackaged, resourcesPath, fileExists, homeDir }) {
  const envKeyPath = env.SEEON_GPU_SSH_KEY ? expandHomeDir({ filePath: env.SEEON_GPU_SSH_KEY, homeDir }) : null;
  if (envKeyPath && fileExists(envKeyPath)) return envKeyPath;
  if (envKeyPath) console.warn('[gpu-tunnel] SEEON_GPU_SSH_KEY 에 적은 키 파일을 찾지 못했습니다');
  const packagedKeyPath = isPackaged && resourcesPath ? path.join(resourcesPath, PACKAGED_KEY_FILE_NAME) : null;
  if (packagedKeyPath && fileExists(packagedKeyPath)) return packagedKeyPath;
  return null;
}

function readTunnelConfig({
  env = process.env, isPackaged = false, resourcesPath = '', fileExists = fs.existsSync, homeDir = os.homedir(),
} = {}) {
  return {
    mode: readTunnelMode(env),
    host: env.SEEON_GPU_SSH_HOST || null,
    port: readSshPort(env),
    username: env.SEEON_GPU_SSH_USER || null,
    keyPath: resolveKeyPath({ env, isPackaged, resourcesPath, fileExists, homeDir }),
    // 서버 호스트 키 지문. 실제 서버 키와 다르면 중간자일 수 있어 연결하지 않는다.
    hostFingerprint: env.SEEON_GPU_SSH_HOST_FINGERPRINT || null,
  };
}

function isServerConfigured(tunnelConfig) {
  return Boolean(tunnelConfig.host && tunnelConfig.username && tunnelConfig.hostFingerprint);
}

function readLocalPort(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (!LOCAL_HOSTNAME_LIST.includes(parsedUrl.hostname) || !parsedUrl.port) return null;
  return Number(parsedUrl.port);
}

// 파이프라인이 로컬 포트로 부르는 GPU 서비스만 터널로 넘긴다. 원격 주소를 직접 쓰는 서비스는 건드리지 않는다.
function buildForwardList({ pipelineConfig }) {
  const portList = FORWARD_URL_KEY_LIST
    .map((key) => readLocalPort(pipelineConfig[key]))
    .filter((port) => port !== null);
  return [...new Set(portList)].map((port) => ({ localPort: port, remotePort: port }));
}

module.exports = {
  readTunnelConfig, buildForwardList, isServerConfigured, TUNNEL_MODE_MAP, DEFAULT_SSH_PORT, PACKAGED_KEY_FILE_NAME,
};
