import { defaultUiText } from '../i18n/ui-text.js';

// GPU 서버 터널 상태를 캡션 언어로 쓴다. main 은 상태 코드와 함께 한국어 문구(label)를 보내는데,
// 그 문구는 캡션 언어를 따르지 않으므로 상태 코드로 다시 고른다. 모르는 코드가 오면 main 의 문구를 그대로 쓴다.
// 코드 값은 main gpu-tunnel/tunnel-status.js 의 TUNNEL_STATUS_MAP·TUNNEL_REASON_MAP 과 같다.
const STATUS_TEXT_KEY_MAP = {
  off: 'gpuTunnel.off',
  no_key: 'gpuTunnel.noKey',
  external: 'gpuTunnel.external',
  connecting: 'gpuTunnel.connecting',
  connected: 'gpuTunnel.connected',
  reconnecting: 'gpuTunnel.reconnecting',
};

const REASON_TEXT_KEY_MAP = {
  host_key_mismatch: 'gpuTunnel.reason.hostKeyMismatch',
  auth_failed: 'gpuTunnel.reason.authFailed',
  key_invalid: 'gpuTunnel.reason.keyInvalid',
  timeout: 'gpuTunnel.reason.timeout',
  network: 'gpuTunnel.reason.network',
  disconnected: 'gpuTunnel.reason.disconnected',
};

// main 처럼 사유는 다시 연결 중일 때만 붙인다.
export function describeGpuTunnelStatus({ status, reason = null, label = '', t = defaultUiText }) {
  const statusKey = STATUS_TEXT_KEY_MAP[status];
  if (!statusKey) return label;
  const statusText = t(statusKey);
  if (status !== 'reconnecting' || !reason) return statusText;
  const reasonKey = REASON_TEXT_KEY_MAP[reason];
  return t('gpuTunnel.withReason', { status: statusText, reason: reasonKey ? t(reasonKey) : reason });
}
