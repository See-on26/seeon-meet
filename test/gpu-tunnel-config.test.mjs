import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  readTunnelConfig, buildForwardList, TUNNEL_MODE_MAP,
  DEFAULT_SSH_HOST, DEFAULT_SSH_PORT, DEFAULT_SSH_USER, DEFAULT_HOST_FINGERPRINT, PACKAGED_KEY_FILE_NAME,
} = require('../src/main/gpu-tunnel/tunnel-config.js');
const { computeHostKeyFingerprint, isHostKeyFingerprintMatch } = require('../src/main/gpu-tunnel/host-key.js');
const {
  computeReconnectDelayMs, classifyTunnelError, describeTunnelStatus, TUNNEL_STATUS_MAP, TUNNEL_REASON_MAP,
} = require('../src/main/gpu-tunnel/tunnel-status.js');
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');

// ssh-keygen 으로 만든 일회용 ed25519 공개 키와 `ssh-keygen -lf` 가 보여 준 지문.
const SAMPLE_HOST_KEY_BASE64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIO9fCJ5JyDmyj8hFZWB3z3v/D7aiPOmo/ZzMZwJv32KO';
const SAMPLE_HOST_KEY_FINGERPRINT = 'SHA256:O4mnAwWxaj6HXUWQLocIy5DFenjdK6WShmDBWDeyo/o';

const RESOURCES_PATH = '/Applications/SEEON.app/Contents/Resources';
const PACKAGED_KEY_PATH = path.join(RESOURCES_PATH, PACKAGED_KEY_FILE_NAME);

function fileExistsAmong(pathList) {
  return (filePath) => pathList.includes(filePath);
}

afterEach(() => { mock.restoreAll(); });

test('설정 기본값: auto, 팀 GPU 서버 주소·포트·계정·지문', () => {
  const config = readTunnelConfig({ env: {}, fileExists: () => false });
  assert.equal(config.mode, TUNNEL_MODE_MAP.auto);
  assert.equal(config.host, '<서버 주소>');
  assert.equal(config.port, 22);
  assert.equal(config.username, '@GPU_USER@');
  assert.equal(config.hostFingerprint, '<서버 호스트 키 지문>');
  assert.equal(DEFAULT_SSH_HOST, config.host);
  assert.equal(DEFAULT_SSH_PORT, config.port);
  assert.equal(DEFAULT_SSH_USER, config.username);
  assert.equal(DEFAULT_HOST_FINGERPRINT, config.hostFingerprint);
});

test('설정: 환경변수로 주소·포트·계정·지문을 바꾼다', () => {
  const config = readTunnelConfig({
    env: {
      SEEON_GPU_SSH_HOST: 'gpu.example.com', SEEON_GPU_SSH_PORT: '2222',
      SEEON_GPU_SSH_USER: 'tester', SEEON_GPU_SSH_HOST_FINGERPRINT: SAMPLE_HOST_KEY_FINGERPRINT,
    },
    fileExists: () => false,
  });
  assert.equal(config.host, 'gpu.example.com');
  assert.equal(config.port, 2222);
  assert.equal(config.username, 'tester');
  assert.equal(config.hostFingerprint, SAMPLE_HOST_KEY_FINGERPRINT);
});

test('설정: SEEON_GPU_TUNNEL=off 면 off, 모르는 값은 경고하고 auto', () => {
  assert.equal(readTunnelConfig({ env: { SEEON_GPU_TUNNEL: 'off' }, fileExists: () => false }).mode, TUNNEL_MODE_MAP.off);
  assert.equal(readTunnelConfig({ env: { SEEON_GPU_TUNNEL: 'auto' }, fileExists: () => false }).mode, TUNNEL_MODE_MAP.auto);
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(readTunnelConfig({ env: { SEEON_GPU_TUNNEL: 'yes' }, fileExists: () => false }).mode, TUNNEL_MODE_MAP.auto);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /SEEON_GPU_TUNNEL/);
});

test('설정: SSH 포트가 숫자가 아니면 경고하고 기본 포트', () => {
  const warn = mock.method(console, 'warn', () => {});
  assert.equal(readTunnelConfig({ env: { SEEON_GPU_SSH_PORT: 'abc' }, fileExists: () => false }).port, 22);
  assert.equal(warn.mock.callCount(), 1);
});

test('키 경로: SEEON_GPU_SSH_KEY 가 패키지 리소스 키보다 먼저다', () => {
  const config = readTunnelConfig({
    env: { SEEON_GPU_SSH_KEY: '/keys/app-key' },
    isPackaged: true, resourcesPath: RESOURCES_PATH,
    fileExists: fileExistsAmong(['/keys/app-key', PACKAGED_KEY_PATH]),
  });
  assert.equal(config.keyPath, '/keys/app-key');
});

test('키 경로: 환경변수가 없으면 패키지 앱의 resources/gpu-tunnel-key', () => {
  const config = readTunnelConfig({
    env: {}, isPackaged: true, resourcesPath: RESOURCES_PATH, fileExists: fileExistsAmong([PACKAGED_KEY_PATH]),
  });
  assert.equal(config.keyPath, PACKAGED_KEY_PATH);
});

test('키 경로: 개발 실행(패키지 아님)이면 리소스 키를 보지 않는다', () => {
  const config = readTunnelConfig({
    env: {}, isPackaged: false, resourcesPath: RESOURCES_PATH, fileExists: fileExistsAmong([PACKAGED_KEY_PATH]),
  });
  assert.equal(config.keyPath, null);
});

test('키 경로: 환경변수 경로에 파일이 없으면 경고하고 다음 후보, 둘 다 없으면 null', () => {
  const warn = mock.method(console, 'warn', () => {});
  const packagedConfig = readTunnelConfig({
    env: { SEEON_GPU_SSH_KEY: '/keys/missing' },
    isPackaged: true, resourcesPath: RESOURCES_PATH, fileExists: fileExistsAmong([PACKAGED_KEY_PATH]),
  });
  assert.equal(packagedConfig.keyPath, PACKAGED_KEY_PATH);
  const noKeyConfig = readTunnelConfig({ env: { SEEON_GPU_SSH_KEY: '/keys/missing' }, fileExists: () => false });
  assert.equal(noKeyConfig.keyPath, null);
  assert.equal(warn.mock.callCount(), 2);
  for (const call of warn.mock.calls) assert.doesNotMatch(call.arguments[0], /\/keys\/missing/);
});

test('키 경로: ~/ 로 시작하면 홈 디렉터리로 바꾼다', () => {
  const config = readTunnelConfig({
    env: { SEEON_GPU_SSH_KEY: '~/keystore/app-key' }, homeDir: '/Users/tester',
    fileExists: fileExistsAmong(['/Users/tester/keystore/app-key']),
  });
  assert.equal(config.keyPath, '/Users/tester/keystore/app-key');
});

test('전달 포트: 기본 파이프라인 설정이면 8801·8802·8803·8804 (TTS 두 주소는 하나로)', () => {
  const forwardList = buildForwardList({ pipelineConfig: readPipelineConfig({}) });
  assert.deepEqual(forwardList, [
    { localPort: 8801, remotePort: 8801 },
    { localPort: 8802, remotePort: 8802 },
    { localPort: 8803, remotePort: 8803 },
    { localPort: 8804, remotePort: 8804 },
  ]);
});

test('전달 포트: 원격 주소·포트 없는 주소·잘못된 주소는 빼고 localhost 는 넣는다', () => {
  const forwardList = buildForwardList({
    pipelineConfig: {
      vlmUrl: 'http://gpu.example.com:8801/v1/chat/completions',
      asrUrl: 'http://localhost:9902/asr',
      ttsUrl: 'http://127.0.0.1:9903/tts',
      ttsLongUrl: 'http://127.0.0.1/tts-long',
      embedUrl: 'not a url',
    },
  });
  assert.deepEqual(forwardList, [
    { localPort: 9902, remotePort: 9902 },
    { localPort: 9903, remotePort: 9903 },
  ]);
});

test('지문: 호스트 공개 키의 SHA256 을 OpenSSH 표기(SHA256:base64, = 없음)로 계산한다', () => {
  const hostKey = Buffer.from(SAMPLE_HOST_KEY_BASE64, 'base64');
  assert.equal(computeHostKeyFingerprint(hostKey), SAMPLE_HOST_KEY_FINGERPRINT);
});

test('지문 비교: 같으면 통과, 다르거나 비어 있으면 거부, 끝의 = 와 공백은 무시', () => {
  const hostKey = Buffer.from(SAMPLE_HOST_KEY_BASE64, 'base64');
  assert.equal(isHostKeyFingerprintMatch({ hostKey, expectedFingerprint: SAMPLE_HOST_KEY_FINGERPRINT }), true);
  assert.equal(isHostKeyFingerprintMatch({ hostKey, expectedFingerprint: ` ${SAMPLE_HOST_KEY_FINGERPRINT}= ` }), true);
  assert.equal(isHostKeyFingerprintMatch({ hostKey, expectedFingerprint: DEFAULT_HOST_FINGERPRINT }), false);
  assert.equal(isHostKeyFingerprintMatch({ hostKey, expectedFingerprint: '' }), false);
  assert.equal(isHostKeyFingerprintMatch({ hostKey: Buffer.alloc(0), expectedFingerprint: SAMPLE_HOST_KEY_FINGERPRINT }), false);
});

test('재연결 간격: 2초에서 두 배씩 늘고 30초를 넘지 않는다', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map(computeReconnectDelayMs), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('끊긴 이유: 지문 불일치 > 인증 실패 > 시간 초과 > 네트워크, 오류 없이 닫히면 끊김', () => {
  assert.equal(classifyTunnelError({ error: new Error('Host denied'), isHostKeyMismatch: true }), TUNNEL_REASON_MAP.hostKeyMismatch);
  assert.equal(classifyTunnelError({ error: Object.assign(new Error('auth'), { level: 'client-authentication' }) }), TUNNEL_REASON_MAP.authFailed);
  assert.equal(classifyTunnelError({ error: Object.assign(new Error('timeout'), { level: 'client-timeout' }) }), TUNNEL_REASON_MAP.timeout);
  assert.equal(classifyTunnelError({ error: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }), TUNNEL_REASON_MAP.network);
  assert.equal(classifyTunnelError({ error: null }), TUNNEL_REASON_MAP.disconnected);
});

test('화면 표시: 상태마다 한국어 한 줄, 다시 연결 중이면 이유를 붙인다', () => {
  assert.equal(describeTunnelStatus({ status: TUNNEL_STATUS_MAP.connected }), '연결됨');
  assert.equal(describeTunnelStatus({ status: TUNNEL_STATUS_MAP.connecting }), '연결 중');
  assert.equal(describeTunnelStatus({ status: TUNNEL_STATUS_MAP.external }), '외부 터널');
  assert.equal(describeTunnelStatus({ status: TUNNEL_STATUS_MAP.noKey }), '키 없음');
  assert.equal(describeTunnelStatus({ status: TUNNEL_STATUS_MAP.off }), '꺼짐');
  assert.equal(
    describeTunnelStatus({ status: TUNNEL_STATUS_MAP.reconnecting, reason: TUNNEL_REASON_MAP.authFailed, retryInMs: 4000 }),
    '다시 연결 중 (인증 실패)',
  );
  assert.equal(
    describeTunnelStatus({ status: TUNNEL_STATUS_MAP.reconnecting, reason: TUNNEL_REASON_MAP.hostKeyMismatch, retryInMs: 2000 }),
    '다시 연결 중 (서버 지문 불일치)',
  );
});
