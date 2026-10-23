const TUNNEL_STATUS_MAP = {
  off: 'off',
  notConfigured: 'not_configured',
  noKey: 'no_key',
  external: 'external',
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
};

const TUNNEL_REASON_MAP = {
  hostKeyMismatch: 'host_key_mismatch',
  authFailed: 'auth_failed',
  keyInvalid: 'key_invalid',
  timeout: 'timeout',
  network: 'network',
  disconnected: 'disconnected',
};

const TUNNEL_STATUS_LABEL_MAP = {
  [TUNNEL_STATUS_MAP.off]: '꺼짐',
  [TUNNEL_STATUS_MAP.notConfigured]: '서버 설정 없음',
  [TUNNEL_STATUS_MAP.noKey]: '키 없음',
  [TUNNEL_STATUS_MAP.external]: '외부 터널',
  [TUNNEL_STATUS_MAP.connecting]: '연결 중',
  [TUNNEL_STATUS_MAP.connected]: '연결됨',
  [TUNNEL_STATUS_MAP.reconnecting]: '다시 연결 중',
};

const TUNNEL_REASON_LABEL_MAP = {
  [TUNNEL_REASON_MAP.hostKeyMismatch]: '서버 지문 불일치',
  [TUNNEL_REASON_MAP.authFailed]: '인증 실패',
  [TUNNEL_REASON_MAP.keyInvalid]: '키 형식 오류',
  [TUNNEL_REASON_MAP.timeout]: '응답 없음',
  [TUNNEL_REASON_MAP.network]: '네트워크 오류',
  [TUNNEL_REASON_MAP.disconnected]: '연결 끊김',
};

// 외부 터널 스크립트와 같은 첫 간격(2초)에서 두 배씩 늘린다.
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;

function computeReconnectDelayMs(failureCount) {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** failureCount, RECONNECT_MAX_DELAY_MS);
}

// ssh2 는 지문 불일치를 일반 핸드셰이크 오류로 알리므로, 검증 함수가 남긴 표시를 먼저 본다.
function classifyTunnelError({ error, isHostKeyMismatch = false }) {
  if (isHostKeyMismatch) return TUNNEL_REASON_MAP.hostKeyMismatch;
  if (!error) return TUNNEL_REASON_MAP.disconnected;
  if (error.level === 'client-authentication') return TUNNEL_REASON_MAP.authFailed;
  if (error.level === 'client-timeout') return TUNNEL_REASON_MAP.timeout;
  return TUNNEL_REASON_MAP.network;
}

function describeTunnelStatus({ status, reason = null }) {
  const label = TUNNEL_STATUS_LABEL_MAP[status] || status;
  if (status !== TUNNEL_STATUS_MAP.reconnecting || !reason) return label;
  return `${label} (${TUNNEL_REASON_LABEL_MAP[reason] || reason})`;
}

module.exports = {
  TUNNEL_STATUS_MAP, TUNNEL_REASON_MAP, computeReconnectDelayMs, classifyTunnelError, describeTunnelStatus,
};
